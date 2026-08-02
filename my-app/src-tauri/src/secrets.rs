use keyring_core::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub(crate) const KEYCHAIN_SERVICE: &str = "com.lunerylab.studio.provider";

/// Short positive-cache TTL for configured provider secrets. Repeated authenticated
/// reads of one provider reuse this entry instead of spending keychain miss budget.
const SECRET_CACHE_TTL: Duration = Duration::from_secs(30);
/// Status reads are memory-only. Expired presence remains a usable snapshot
/// while one background worker refreshes it away from the status call path.
const SECRET_PRESENCE_TTL: Duration = Duration::from_secs(30);
/// Authenticated real keychain reads. High enough for legitimate multi-provider
/// startup while still bounding malicious cache-miss churn.
const SECRET_READ_LIMIT: usize = 60;
/// Missing/unavailable backend outcomes get a tighter abuse budget without
/// penalizing configured providers that resolve successfully.
const SECRET_FAILURE_LIMIT: usize = 10;
const SECRET_MISS_WINDOW: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderSecretPayload {
    provider_id: String,
    api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderIdPayload {
    pub(crate) provider_id: String,
}

#[derive(Serialize)]
pub(crate) struct ProviderSecretStatus {
    provider_id: String,
    configured: bool,
    secret_store: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeychainSecretState {
    Present,
    Missing,
    Unavailable,
}

impl KeychainSecretState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Present => "present",
            Self::Missing => "missing",
            Self::Unavailable => "unavailable",
        }
    }

    pub(crate) fn is_present(self) -> bool {
        self == Self::Present
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderSecretReadError {
    InvalidProvider,
    Missing,
    Unavailable,
    RateLimited,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderSecretMutationError {
    InvalidProvider,
    InvalidSecret,
    Unavailable,
}

impl ProviderSecretMutationError {
    pub(crate) fn public_message(self) -> &'static str {
        match self {
            Self::InvalidProvider => "Invalid provider id",
            Self::InvalidSecret => "API key is required",
            Self::Unavailable => "System keychain is unavailable",
        }
    }
}

impl Serialize for ProviderSecretMutationError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.public_message())
    }
}

impl ProviderSecretReadError {
    pub(crate) fn audit_reason(self) -> &'static str {
        match self {
            Self::InvalidProvider => "invalid_provider",
            Self::Missing => "missing",
            Self::Unavailable => "keychain_unavailable",
            Self::RateLimited => "rate_limited",
        }
    }

    pub(crate) fn public_message(self) -> &'static str {
        match self {
            Self::InvalidProvider => "Invalid provider id",
            Self::Missing => "Provider secret is not configured",
            Self::Unavailable => "System keychain is unavailable",
            Self::RateLimited => "Secret-read rate limit exceeded.",
        }
    }
}

pub(crate) fn validate_provider_id(provider_id: &str) -> Result<(), String> {
    let ok = !provider_id.is_empty()
        && provider_id.len() <= 64
        && provider_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err("Invalid provider id".to_string())
    }
}

pub(crate) fn provider_entry(provider_id: &str) -> Result<Entry, ProviderSecretMutationError> {
    keyring::use_native_store(true).map_err(|_| ProviderSecretMutationError::Unavailable)?;
    Entry::new(KEYCHAIN_SERVICE, provider_id).map_err(|_| ProviderSecretMutationError::Unavailable)
}

#[derive(Clone)]
struct CachedSecret {
    value: String,
    expires_at: Instant,
}

#[derive(Clone, Copy)]
struct CachedPresence {
    state: KeychainSecretState,
    expires_at: Instant,
}

struct InflightRead {
    done: Mutex<Option<Result<String, ProviderSecretReadError>>>,
    cv: Condvar,
}

struct SecretReadState {
    cache: HashMap<String, CachedSecret>,
    inflight: HashMap<String, Arc<InflightRead>>,
    generations: HashMap<String, u64>,
    presence: HashMap<String, CachedPresence>,
    presence_queue: VecDeque<String>,
    presence_queued: HashSet<String>,
    presence_worker_active: bool,
    read_times: Vec<Instant>,
    failure_times: Vec<Instant>,
}

fn secret_read_state() -> &'static Mutex<SecretReadState> {
    static STATE: OnceLock<Mutex<SecretReadState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(SecretReadState {
            cache: HashMap::new(),
            inflight: HashMap::new(),
            generations: HashMap::new(),
            presence: HashMap::new(),
            presence_queue: VecDeque::new(),
            presence_queued: HashSet::new(),
            presence_worker_active: false,
            read_times: Vec::new(),
            failure_times: Vec::new(),
        })
    })
}

/// Positive-cache misses that will perform a real OS-keychain read consume this
/// budget before the backend call — success, Missing, and Unavailable alike.
/// Cache hits and same-provider inflight followers are free. Returns false when
/// the limiter is exhausted (caller must not touch the keychain).
fn consume_keychain_read_budget(state: &mut SecretReadState, now: Instant) -> bool {
    state
        .read_times
        .retain(|t| now.duration_since(*t) <= SECRET_MISS_WINDOW);
    state
        .failure_times
        .retain(|t| now.duration_since(*t) <= SECRET_MISS_WINDOW);
    if state.read_times.len() >= SECRET_READ_LIMIT
        || state.failure_times.len() >= SECRET_FAILURE_LIMIT
    {
        return false;
    }
    state.read_times.push(now);
    true
}

fn record_keychain_read_failure(now: Instant) {
    let mut state = secret_read_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state
        .failure_times
        .retain(|t| now.duration_since(*t) <= SECRET_MISS_WINDOW);
    state.failure_times.push(now);
}

/// Ensures every leader exit removes the inflight entry and wakes followers —
/// including panic/poison paths that never reach an explicit publish.
struct InflightLeaderGuard {
    provider_id: String,
    inflight: Arc<InflightRead>,
    generation: u64,
    settled: bool,
}

impl InflightLeaderGuard {
    fn new(provider_id: &str, inflight: Arc<InflightRead>, generation: u64) -> Self {
        Self {
            provider_id: provider_id.to_string(),
            inflight,
            generation,
            settled: false,
        }
    }

    fn publish(
        mut self,
        outcome: Result<String, ProviderSecretReadError>,
        now: Instant,
    ) -> Result<String, ProviderSecretReadError> {
        self.publish_inner(outcome.clone(), now);
        self.settled = true;
        outcome
    }

    fn publish_inner(&mut self, outcome: Result<String, ProviderSecretReadError>, now: Instant) {
        let mut state = secret_read_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state
            .inflight
            .get(&self.provider_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.inflight))
        {
            state.inflight.remove(&self.provider_id);
        }
        let generation_is_current = state
            .generations
            .get(&self.provider_id)
            .copied()
            .unwrap_or(0)
            == self.generation;
        if generation_is_current {
            let presence = match outcome {
                Ok(ref value) => {
                    state.cache.insert(
                        self.provider_id.clone(),
                        CachedSecret {
                            value: value.clone(),
                            expires_at: now + SECRET_CACHE_TTL,
                        },
                    );
                    KeychainSecretState::Present
                }
                Err(ProviderSecretReadError::Missing) => KeychainSecretState::Missing,
                Err(_) => KeychainSecretState::Unavailable,
            };
            state.presence.insert(
                self.provider_id.clone(),
                CachedPresence {
                    state: presence,
                    expires_at: now + SECRET_PRESENCE_TTL,
                },
            );
        }
        drop(state);
        let mut slot = self
            .inflight
            .done
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_none() {
            *slot = Some(outcome);
        }
        self.inflight.cv.notify_all();
    }
}

impl Drop for InflightLeaderGuard {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        self.publish_inner(Err(ProviderSecretReadError::Unavailable), Instant::now());
    }
}

fn invalidate_provider_secret_cache_inner(
    provider_id: &str,
    presence: Option<KeychainSecretState>,
) {
    let mut state = secret_read_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let generation = state
        .generations
        .entry(provider_id.to_string())
        .or_default();
    *generation = generation.wrapping_add(1);
    state.cache.remove(provider_id);
    // Readers that started before a successful mutation may still complete
    // for their existing callers, but new callers must elect a new-generation
    // leader instead of following the stale read.
    state.inflight.remove(provider_id);
    state.presence_queue.retain(|queued| queued != provider_id);
    state.presence_queued.remove(provider_id);
    if let Some(presence) = presence {
        state.presence.insert(
            provider_id.to_string(),
            CachedPresence {
                state: presence,
                expires_at: Instant::now() + SECRET_PRESENCE_TTL,
            },
        );
    } else {
        state.presence.remove(provider_id);
    }
}

#[cfg(test)]
pub(crate) fn invalidate_provider_secret_cache(provider_id: &str) {
    invalidate_provider_secret_cache_inner(provider_id, None);
}

/// Append a tamper-evident-ish audit line for every secret-read attempt. We
/// log to stderr only — the desktop runtime is single-user, so the OS event
/// log + Console.app are the persistence layer. NEVER logs the key material.
pub(crate) fn audit_secret_read(provider_id: &str, allowed: bool, reason: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    eprintln!(
        "[lunerylab][audit] secret-read ts={ts} provider={provider_id} allowed={allowed} reason={reason}"
    );
}

fn classify_keychain_read_error(error: KeyringError) -> ProviderSecretReadError {
    match error {
        KeyringError::NoEntry => ProviderSecretReadError::Missing,
        _ => ProviderSecretReadError::Unavailable,
    }
}

fn classify_keychain_mutation_error(_error: KeyringError) -> ProviderSecretMutationError {
    ProviderSecretMutationError::Unavailable
}

fn read_keychain_password(provider_id: &str) -> Result<String, ProviderSecretReadError> {
    let entry = provider_entry(provider_id).map_err(|_| ProviderSecretReadError::Unavailable)?;
    entry.get_password().map_err(classify_keychain_read_error)
}

type PresenceReader =
    Arc<dyn Fn(&str) -> Result<String, ProviderSecretReadError> + Send + Sync + 'static>;

struct PresenceWorkerGuard;

impl Drop for PresenceWorkerGuard {
    fn drop(&mut self) {
        let mut state = secret_read_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.presence_worker_active = false;
    }
}

fn run_presence_worker(reader: PresenceReader) {
    let _guard = PresenceWorkerGuard;
    loop {
        let provider_id = {
            let mut state = secret_read_state()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(provider_id) = state.presence_queue.pop_front() else {
                // Clear while holding the queue mutex so a concurrent status
                // enqueue either observes an active worker or starts a new one.
                state.presence_worker_active = false;
                return;
            };
            provider_id
        };
        let _ = resolve_provider_secret_with(&provider_id, Instant::now(), |id| reader(id));
        let mut state = secret_read_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.presence_queued.remove(&provider_id);
    }
}

/// Returns a memory snapshot immediately. A cache miss or stale snapshot only
/// enqueues one background refresh; the desktop status command never waits for
/// the OS keychain and cannot fan out one blocked keychain thread per provider.
fn keychain_secret_state_with(
    provider_id: &str,
    now: Instant,
    reader: PresenceReader,
) -> KeychainSecretState {
    if validate_provider_id(provider_id).is_err() {
        return KeychainSecretState::Unavailable;
    }
    let (snapshot, spawn_worker) = {
        let mut state = secret_read_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cached = state.presence.get(provider_id).copied();
        let snapshot = cached
            .map(|presence| presence.state)
            .unwrap_or(KeychainSecretState::Unavailable);
        if cached.is_none_or(|presence| presence.expires_at <= now)
            && state.presence_queued.insert(provider_id.to_string())
        {
            state.presence_queue.push_back(provider_id.to_string());
        }
        let spawn_worker = !state.presence_worker_active && !state.presence_queue.is_empty();
        if spawn_worker {
            state.presence_worker_active = true;
        }
        (snapshot, spawn_worker)
    };
    if spawn_worker
        && std::thread::Builder::new()
            .name("lunery-secret-presence".to_string())
            .spawn(move || run_presence_worker(reader))
            .is_err()
    {
        let mut state = secret_read_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.presence_worker_active = false;
    }
    snapshot
}

pub(crate) fn keychain_secret_state(provider_id: &str) -> KeychainSecretState {
    keychain_secret_state_with(
        provider_id,
        Instant::now(),
        Arc::new(read_keychain_password),
    )
}

/// Resolve a provider secret through the positive cache / same-provider
/// single-flight / positive-cache-miss limiter path. `read_keychain` is injected
/// so deterministic tests never touch the OS keychain.
///
/// Budget rule: every elected leader that will perform a real keychain read
/// consumes one unit *before* calling the backend. Cache hits and same-provider
/// followers cost zero. Exhausted leaders publish `RateLimited` without a
/// backend call.
pub(crate) fn resolve_provider_secret_with<F>(
    provider_id: &str,
    now: Instant,
    mut read_keychain: F,
) -> Result<String, ProviderSecretReadError>
where
    F: FnMut(&str) -> Result<String, ProviderSecretReadError>,
{
    if provider_id.is_empty() {
        return Err(ProviderSecretReadError::InvalidProvider);
    }
    validate_provider_id(provider_id).map_err(|_| ProviderSecretReadError::InvalidProvider)?;

    let mut state = secret_read_state()
        .lock()
        .map_err(|_| ProviderSecretReadError::Unavailable)?;

    if let Some(cached) = state.cache.get(provider_id) {
        if cached.expires_at > now {
            return Ok(cached.value.clone());
        }
        state.cache.remove(provider_id);
    }

    if let Some(inflight) = state.inflight.get(provider_id).cloned() {
        drop(state);
        let guard = inflight
            .done
            .lock()
            .map_err(|_| ProviderSecretReadError::Unavailable)?;
        let finished = inflight
            .cv
            .wait_while(guard, |slot| slot.is_none())
            .map_err(|_| ProviderSecretReadError::Unavailable)?;
        return finished
            .clone()
            .unwrap_or(Err(ProviderSecretReadError::Unavailable));
    }

    let inflight = Arc::new(InflightRead {
        done: Mutex::new(None),
        cv: Condvar::new(),
    });
    state
        .inflight
        .insert(provider_id.to_string(), Arc::clone(&inflight));
    let generation = state.generations.get(provider_id).copied().unwrap_or(0);

    // Charge before any OS-keychain / injected backend read.
    if !consume_keychain_read_budget(&mut state, now) {
        drop(state);
        return InflightLeaderGuard::new(provider_id, inflight, generation)
            .publish(Err(ProviderSecretReadError::RateLimited), now);
    }
    drop(state);

    let leader = InflightLeaderGuard::new(provider_id, inflight, generation);
    let outcome = read_keychain(provider_id);
    if matches!(
        outcome,
        Err(ProviderSecretReadError::Missing | ProviderSecretReadError::Unavailable)
    ) {
        record_keychain_read_failure(now);
    }
    leader.publish(outcome, now)
}

#[tauri::command]
pub(crate) fn save_provider_secret(
    payload: ProviderSecretPayload,
) -> Result<ProviderSecretStatus, ProviderSecretMutationError> {
    if payload.provider_id.trim().is_empty() {
        return Err(ProviderSecretMutationError::InvalidProvider);
    }
    if payload.api_key.trim().is_empty() {
        return Err(ProviderSecretMutationError::InvalidSecret);
    }

    let provider_id = payload.provider_id.trim().to_string();
    validate_provider_id(&provider_id).map_err(|_| ProviderSecretMutationError::InvalidProvider)?;
    let entry = provider_entry(&provider_id)?;
    entry
        .set_password(payload.api_key.trim())
        .map_err(classify_keychain_mutation_error)?;

    invalidate_provider_secret_cache_inner(&provider_id, Some(KeychainSecretState::Present));

    Ok(ProviderSecretStatus {
        provider_id,
        configured: true,
        secret_store: "system-keychain",
    })
}

/// Read a provider API key from the OS keychain (via positive cache).
/// SECURITY: the key is returned to the Rust bridge only and is NEVER logged.
/// Do not expose this as a Tauri command; `/provider-secret-read` adds token
/// auth, loopback checks, and audit logs around this helper.
pub(crate) fn get_provider_secret(
    payload: ProviderIdPayload,
) -> Result<String, ProviderSecretReadError> {
    let provider_id = payload.provider_id.trim().to_string();
    resolve_provider_secret_with(&provider_id, Instant::now(), read_keychain_password)
}

#[tauri::command]
pub(crate) fn delete_provider_secret(
    payload: ProviderIdPayload,
) -> Result<ProviderSecretStatus, ProviderSecretMutationError> {
    let provider_id = payload.provider_id.trim().to_string();
    if provider_id.is_empty() {
        return Err(ProviderSecretMutationError::InvalidProvider);
    }
    validate_provider_id(&provider_id).map_err(|_| ProviderSecretMutationError::InvalidProvider)?;

    let entry = provider_entry(&provider_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => {
            invalidate_provider_secret_cache_inner(
                &provider_id,
                Some(KeychainSecretState::Missing),
            );
            Ok(ProviderSecretStatus {
                provider_id,
                configured: false,
                secret_store: "system-keychain",
            })
        }
        Err(err) => Err(classify_keychain_mutation_error(err)),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_keychain_mutation_error, classify_keychain_read_error,
        invalidate_provider_secret_cache, keychain_secret_state_with, resolve_provider_secret_with,
        secret_read_state, KeychainSecretState, PresenceReader, ProviderSecretMutationError,
        ProviderSecretReadError, SECRET_FAILURE_LIMIT, SECRET_READ_LIMIT,
    };
    use crate::test_global_lock;
    use keyring_core::Error as KeyringError;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    fn reset_secret_state() {
        let mut state = secret_read_state().lock().expect("secret state");
        state.cache.clear();
        state.inflight.clear();
        state.generations.clear();
        state.presence.clear();
        state.presence_queue.clear();
        state.presence_queued.clear();
        state.presence_worker_active = false;
        state.read_times.clear();
        state.failure_times.clear();
    }

    #[test]
    fn no_entry_is_a_normal_missing_secret() {
        assert_eq!(
            classify_keychain_read_error(KeyringError::NoEntry),
            ProviderSecretReadError::Missing
        );
    }

    #[test]
    fn storage_access_failures_are_unavailable_without_backend_details() {
        let backend_error = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "locked");
        assert_eq!(
            classify_keychain_read_error(KeyringError::NoStorageAccess(Box::new(backend_error))),
            ProviderSecretReadError::Unavailable
        );
        assert_eq!(
            ProviderSecretReadError::Unavailable.public_message(),
            "System keychain is unavailable"
        );
    }

    #[test]
    fn mutation_failures_are_typed_without_backend_details() {
        let backend_error = std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "backend-password-do-not-leak",
        );
        let error = classify_keychain_mutation_error(KeyringError::NoStorageAccess(Box::new(
            backend_error,
        )));
        assert_eq!(error, ProviderSecretMutationError::Unavailable);
        assert_eq!(error.public_message(), "System keychain is unavailable");
        assert!(!error
            .public_message()
            .contains("backend-password-do-not-leak"));
    }

    #[test]
    fn twenty_same_provider_calls_perform_one_backend_read() {
        let _g = test_global_lock();
        reset_secret_state();
        let reads = AtomicUsize::new(0);
        let now = Instant::now();
        for _ in 0..20 {
            let value = resolve_provider_secret_with("openai", now, |_| {
                reads.fetch_add(1, Ordering::SeqCst);
                Ok("test-key-material".to_string())
            })
            .expect("present secret");
            assert_eq!(value, "test-key-material");
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        // One charged positive-cache miss; nineteen cache hits are free.
        assert_eq!(secret_read_state().lock().unwrap().read_times.len(), 1);
    }

    #[test]
    fn status_presence_is_nonblocking_and_single_worker_bounded() {
        let _g = test_global_lock();
        reset_secret_state();
        let reads = Arc::new(AtomicUsize::new(0));
        let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let reads_worker = Arc::clone(&reads);
        let release_worker = Arc::clone(&release);
        let reader: PresenceReader = Arc::new(move |_| {
            reads_worker.fetch_add(1, Ordering::SeqCst);
            let (lock, cv) = &*release_worker;
            let guard = lock.lock().unwrap();
            let _ = cv
                .wait_timeout_while(guard, Duration::from_secs(2), |released| !*released)
                .unwrap();
            Ok("status-secret".to_string())
        });

        assert_eq!(
            keychain_secret_state_with("status-provider", Instant::now(), Arc::clone(&reader)),
            KeychainSecretState::Unavailable
        );
        for _ in 0..100 {
            if reads.load(Ordering::SeqCst) == 1 {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1);

        let started = Instant::now();
        let mut callers = Vec::new();
        for _ in 0..20 {
            let reader = Arc::clone(&reader);
            callers.push(std::thread::spawn(move || {
                keychain_secret_state_with("status-provider", Instant::now(), reader)
            }));
        }
        for caller in callers {
            assert_eq!(caller.join().unwrap(), KeychainSecretState::Unavailable);
        }
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(reads.load(Ordering::SeqCst), 1);

        let (lock, cv) = &*release;
        *lock.lock().unwrap() = true;
        cv.notify_all();
        for _ in 0..100 {
            let state = secret_read_state().lock().unwrap();
            let ready = !state.presence_worker_active
                && state
                    .presence
                    .get("status-provider")
                    .is_some_and(|presence| presence.state == KeychainSecretState::Present);
            drop(state);
            if ready {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(
            keychain_secret_state_with("status-provider", Instant::now(), reader),
            KeychainSecretState::Present
        );
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn legitimate_distinct_providers_succeed_then_high_limit_blocks_without_backend() {
        let _g = test_global_lock();
        reset_secret_state();
        let reads = AtomicUsize::new(0);
        let now = Instant::now();
        for i in 0..10 {
            let provider = format!("provider-{i}");
            let value = resolve_provider_secret_with(&provider, now, |_| {
                reads.fetch_add(1, Ordering::SeqCst);
                Ok(format!("key-{i}"))
            })
            .expect("present");
            assert_eq!(value, format!("key-{i}"));
        }
        assert_eq!(reads.load(Ordering::SeqCst), 10);

        for i in 10..SECRET_READ_LIMIT {
            resolve_provider_secret_with(&format!("provider-{i}"), now, |_| {
                reads.fetch_add(1, Ordering::SeqCst);
                Ok(format!("key-{i}"))
            })
            .expect("high legitimate read budget");
        }
        assert_eq!(reads.load(Ordering::SeqCst), SECRET_READ_LIMIT);

        let err = resolve_provider_secret_with("provider-extra", now, |_| {
            reads.fetch_add(1, Ordering::SeqCst);
            Ok("should-not-run".to_string())
        })
        .expect_err("rate limited");
        assert_eq!(err, ProviderSecretReadError::RateLimited);
        assert_eq!(reads.load(Ordering::SeqCst), SECRET_READ_LIMIT);
        assert!(secret_read_state().lock().unwrap().inflight.is_empty());
    }

    #[test]
    fn successful_save_and_delete_invalidate_positive_cache() {
        let _g = test_global_lock();
        reset_secret_state();
        let now = Instant::now();
        let reads = AtomicUsize::new(0);
        let _ = resolve_provider_secret_with("anthropic", now, |_| {
            reads.fetch_add(1, Ordering::SeqCst);
            Ok("cached".to_string())
        })
        .expect("cache fill");
        invalidate_provider_secret_cache("anthropic");
        let _ = resolve_provider_secret_with("anthropic", now, |_| {
            reads.fetch_add(1, Ordering::SeqCst);
            Ok("fresh".to_string())
        })
        .expect("refill");
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        assert_eq!(secret_read_state().lock().unwrap().read_times.len(), 2);
    }

    #[test]
    fn missing_and_unavailable_reads_consume_budget_before_backend() {
        let _g = test_global_lock();
        reset_secret_state();
        let now = Instant::now();
        let reads = AtomicUsize::new(0);
        for i in 0..SECRET_FAILURE_LIMIT {
            let err = resolve_provider_secret_with(&format!("missing-{i}"), now, |_| {
                reads.fetch_add(1, Ordering::SeqCst);
                Err(ProviderSecretReadError::Missing)
            })
            .expect_err("missing");
            assert_eq!(err, ProviderSecretReadError::Missing);
        }
        assert_eq!(reads.load(Ordering::SeqCst), SECRET_FAILURE_LIMIT);
        let err = resolve_provider_secret_with("missing-extra", now, |_| {
            reads.fetch_add(1, Ordering::SeqCst);
            Err(ProviderSecretReadError::Unavailable)
        })
        .expect_err("rate limited");
        assert_eq!(err, ProviderSecretReadError::RateLimited);
        assert_eq!(reads.load(Ordering::SeqCst), SECRET_FAILURE_LIMIT);
    }

    #[test]
    fn invalid_provider_consumes_neither_budget_nor_backend() {
        let _g = test_global_lock();
        reset_secret_state();
        let reads = AtomicUsize::new(0);
        let err = resolve_provider_secret_with("BAD_PROVIDER", Instant::now(), |_| {
            reads.fetch_add(1, Ordering::SeqCst);
            Ok("nope".to_string())
        })
        .expect_err("invalid");
        assert_eq!(err, ProviderSecretReadError::InvalidProvider);
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert!(secret_read_state().lock().unwrap().read_times.is_empty());
    }

    #[test]
    fn same_provider_single_flight_is_one_charged_read() {
        let _g = test_global_lock();
        reset_secret_state();
        let reads = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Mutex::new(false));
        let release_cv = Arc::new(std::sync::Condvar::new());

        let reads_leader = Arc::clone(&reads);
        let release_leader = Arc::clone(&release);
        let release_cv_leader = Arc::clone(&release_cv);
        let leader = std::thread::spawn(move || {
            resolve_provider_secret_with("flight", Instant::now(), |_| {
                reads_leader.fetch_add(1, Ordering::SeqCst);
                let guard = release_leader.lock().unwrap();
                let _ = release_cv_leader
                    .wait_timeout_while(guard, Duration::from_secs(2), |ready| !*ready)
                    .unwrap();
                Ok("shared".to_string())
            })
        });

        for _ in 0..50 {
            if reads.load(Ordering::SeqCst) == 1 {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1);

        let reads_follower = Arc::clone(&reads);
        let follower = std::thread::spawn(move || {
            resolve_provider_secret_with("flight", Instant::now(), |_| {
                reads_follower.fetch_add(1, Ordering::SeqCst);
                Ok("should-not-run".to_string())
            })
        });

        std::thread::sleep(Duration::from_millis(20));
        {
            let mut ready = release.lock().unwrap();
            *ready = true;
            release_cv.notify_all();
        }

        assert_eq!(leader.join().unwrap().expect("leader"), "shared");
        assert_eq!(follower.join().unwrap().expect("follower"), "shared");
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(secret_read_state().lock().unwrap().read_times.len(), 1);
        assert!(secret_read_state().lock().unwrap().inflight.is_empty());
    }

    #[test]
    fn mutation_generation_prevents_stale_inflight_cache_republish() {
        let _g = test_global_lock();
        reset_secret_state();
        let old_read_started = Arc::new(std::sync::Barrier::new(2));
        let release_old_read = Arc::new(std::sync::Barrier::new(2));
        let old_read_started_w = Arc::clone(&old_read_started);
        let release_old_read_w = Arc::clone(&release_old_read);
        let old_leader = std::thread::spawn(move || {
            resolve_provider_secret_with("rotated", Instant::now(), |_| {
                old_read_started_w.wait();
                release_old_read_w.wait();
                Ok("old-secret".to_string())
            })
        });
        old_read_started.wait();

        // Models a successful save/delete after its keychain operation. The
        // mutation advances generation and detaches the old in-flight read.
        invalidate_provider_secret_cache("rotated");
        let fresh = resolve_provider_secret_with("rotated", Instant::now(), |_| {
            Ok("new-secret".to_string())
        })
        .expect("new-generation read");
        assert_eq!(fresh, "new-secret");

        release_old_read.wait();
        assert_eq!(
            old_leader.join().unwrap().expect("old caller completes"),
            "old-secret"
        );

        // The late old leader must neither overwrite the fresh cache nor
        // remove a newer in-flight entry.
        let cached = resolve_provider_secret_with("rotated", Instant::now(), |_| {
            panic!("fresh cache must survive stale leader publish")
        })
        .expect("fresh cache");
        assert_eq!(cached, "new-secret");
        let state = secret_read_state().lock().unwrap();
        assert!(state.inflight.is_empty());
        assert_eq!(state.generations.get("rotated"), Some(&1));
    }

    #[test]
    fn expired_cache_entry_is_a_charged_refetch() {
        let _g = test_global_lock();
        reset_secret_state();
        let reads = AtomicUsize::new(0);
        let t0 = Instant::now();
        let _ = resolve_provider_secret_with("ttl", t0, |_| {
            reads.fetch_add(1, Ordering::SeqCst);
            Ok("v1".to_string())
        })
        .unwrap();
        let later = t0 + Duration::from_secs(31);
        let value = resolve_provider_secret_with("ttl", later, |_| {
            reads.fetch_add(1, Ordering::SeqCst);
            Ok("v2".to_string())
        })
        .unwrap();
        assert_eq!(value, "v2");
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        assert_eq!(secret_read_state().lock().unwrap().read_times.len(), 2);
    }

    #[test]
    fn rate_limited_leader_wakes_same_provider_followers_without_backend() {
        let _g = test_global_lock();
        reset_secret_state();
        let now = Instant::now();
        for i in 0..SECRET_READ_LIMIT {
            let _ =
                resolve_provider_secret_with(&format!("fill-{i}"), now, |_| Ok("x".to_string()));
        }

        let reads = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..4 {
            let reads = Arc::clone(&reads);
            let started = Arc::clone(&started);
            handles.push(std::thread::spawn(move || {
                started.fetch_add(1, Ordering::SeqCst);
                resolve_provider_secret_with("rate-flight", Instant::now(), |_| {
                    reads.fetch_add(1, Ordering::SeqCst);
                    Ok("nope".to_string())
                })
            }));
        }
        for handle in handles {
            assert_eq!(
                handle.join().unwrap().expect_err("rate limited"),
                ProviderSecretReadError::RateLimited
            );
        }
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert!(secret_read_state().lock().unwrap().inflight.is_empty());
    }
}
