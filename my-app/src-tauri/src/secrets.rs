use keyring_core::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub(crate) const KEYCHAIN_SERVICE: &str = "com.lunerylab.studio.provider";

/// Short positive-cache TTL for configured provider secrets. Repeated authenticated
/// reads of one provider reuse this entry instead of spending keychain miss budget.
const SECRET_CACHE_TTL: Duration = Duration::from_secs(30);
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

struct InflightRead {
    done: Mutex<Option<Result<String, ProviderSecretReadError>>>,
    cv: Condvar,
}

struct SecretReadState {
    cache: HashMap<String, CachedSecret>,
    inflight: HashMap<String, Arc<InflightRead>>,
    read_times: Vec<Instant>,
    failure_times: Vec<Instant>,
}

fn secret_read_state() -> &'static Mutex<SecretReadState> {
    static STATE: OnceLock<Mutex<SecretReadState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(SecretReadState {
            cache: HashMap::new(),
            inflight: HashMap::new(),
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
    settled: bool,
}

impl InflightLeaderGuard {
    fn new(provider_id: &str, inflight: Arc<InflightRead>) -> Self {
        Self {
            provider_id: provider_id.to_string(),
            inflight,
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
        state.inflight.remove(&self.provider_id);
        if let Ok(ref value) = outcome {
            state.cache.insert(
                self.provider_id.clone(),
                CachedSecret {
                    value: value.clone(),
                    expires_at: now + SECRET_CACHE_TTL,
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

pub(crate) fn invalidate_provider_secret_cache(provider_id: &str) {
    secret_read_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .cache
        .remove(provider_id);
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

pub(crate) fn keychain_secret_state(provider_id: &str) -> KeychainSecretState {
    let Ok(entry) = provider_entry(provider_id) else {
        return KeychainSecretState::Unavailable;
    };
    match entry.get_password() {
        Ok(_) => KeychainSecretState::Present,
        Err(KeyringError::NoEntry) => KeychainSecretState::Missing,
        Err(_) => KeychainSecretState::Unavailable,
    }
}

fn read_keychain_password(provider_id: &str) -> Result<String, ProviderSecretReadError> {
    let entry = provider_entry(provider_id).map_err(|_| ProviderSecretReadError::Unavailable)?;
    entry.get_password().map_err(classify_keychain_read_error)
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

    // Charge before any OS-keychain / injected backend read.
    if !consume_keychain_read_budget(&mut state, now) {
        drop(state);
        return InflightLeaderGuard::new(provider_id, inflight)
            .publish(Err(ProviderSecretReadError::RateLimited), now);
    }
    drop(state);

    let leader = InflightLeaderGuard::new(provider_id, inflight);
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

    invalidate_provider_secret_cache(&provider_id);

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
            invalidate_provider_secret_cache(&provider_id);
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
        invalidate_provider_secret_cache, resolve_provider_secret_with, secret_read_state,
        ProviderSecretMutationError, ProviderSecretReadError, SECRET_FAILURE_LIMIT,
        SECRET_READ_LIMIT,
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
