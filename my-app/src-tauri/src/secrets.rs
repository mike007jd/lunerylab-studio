use keyring_core::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
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
const SECRET_BACKEND_TIMEOUT: Duration = Duration::from_secs(2);
const SECRET_FOLLOWER_TIMEOUT: Duration = Duration::from_millis(2250);
const KEYCHAIN_READ_HELPER_ARG: &str = "--lunery-keychain-read-helper";

const CANONICAL_PROVIDER_IDS: &[&str] = &[
    "openai",
    "anthropic",
    "gemini",
    "xai",
    "mistral",
    "deepseek",
    "groq",
    "perplexity",
    "cerebras",
    "openrouter",
    "minimax",
    "replicate",
    "fal",
    "together",
    "fireworks",
    "meshy",
    "tripo",
    "openai-compatible",
];

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
    Absent,
    Unknown,
}

impl KeychainSecretState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Present => "present",
            Self::Absent => "absent",
            Self::Unknown => "unknown",
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

#[derive(Default)]
struct SecretRuntime {
    cancelled: AtomicBool,
    epoch: AtomicU64,
    next_helper_id: AtomicU64,
    helpers: Mutex<HashMap<u64, Arc<Mutex<Option<Child>>>>>,
    presence_worker: Mutex<Option<JoinHandle<()>>>,
    wake_lock: Mutex<()>,
    wake: Condvar,
}

fn secret_runtime() -> &'static SecretRuntime {
    static RUNTIME: OnceLock<SecretRuntime> = OnceLock::new();
    RUNTIME.get_or_init(SecretRuntime::default)
}

impl SecretRuntime {
    fn capture_epoch(&self) -> Result<u64, ProviderSecretReadError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(ProviderSecretReadError::Unavailable)
        } else {
            Ok(self.epoch.load(Ordering::Acquire))
        }
    }

    fn is_current(&self, epoch: u64) -> bool {
        !self.cancelled.load(Ordering::Acquire) && self.epoch.load(Ordering::Acquire) == epoch
    }

    fn wait_or_cancel(&self, duration: Duration, epoch: u64) -> bool {
        if !self.is_current(epoch) {
            return true;
        }
        let guard = match self.wake_lock.lock() {
            Ok(guard) => guard,
            Err(_) => return true,
        };
        let _ = self
            .wake
            .wait_timeout_while(guard, duration, |_| self.is_current(epoch));
        !self.is_current(epoch)
    }

    fn register_helper(&self, child: Child) -> (u64, Arc<Mutex<Option<Child>>>) {
        let id = self.next_helper_id.fetch_add(1, Ordering::AcqRel) + 1;
        let child = Arc::new(Mutex::new(Some(child)));
        self.helpers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, Arc::clone(&child));
        (id, child)
    }

    fn unregister_helper(&self, id: u64) {
        self.helpers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&id);
    }

    fn shutdown(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.epoch.fetch_add(1, Ordering::AcqRel);
        self.wake.notify_all();
        {
            let mut state = secret_read_state()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.presence_queue.clear();
            state.presence_queued.clear();
        }
        let helpers = self
            .helpers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for helper in helpers {
            let mut child = helper
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        self.helpers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        let worker = self
            .presence_worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }

    #[cfg(test)]
    fn reset(&self) {
        self.shutdown();
        self.cancelled.store(false, Ordering::Release);
        self.epoch.fetch_add(1, Ordering::AcqRel);
    }
}

pub(crate) fn shutdown_secret_runtime() {
    secret_runtime().shutdown();
}

#[cfg(test)]
pub(crate) fn reset_secret_runtime_for_tests() {
    secret_runtime().reset();
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
                Err(ProviderSecretReadError::Missing) => KeychainSecretState::Absent,
                Err(_) => KeychainSecretState::Unknown,
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

fn canonical_audit_provider(provider_id: &str) -> &'static str {
    CANONICAL_PROVIDER_IDS
        .iter()
        .copied()
        .find(|known| *known == provider_id)
        .unwrap_or("unknown")
}

fn canonical_audit_reason(reason: &str) -> &'static str {
    match reason {
        "ok" => "ok",
        "invalid_request" => "invalid_request",
        "invalid_provider" => "invalid_provider",
        "missing" => "missing",
        "keychain_unavailable" => "keychain_unavailable",
        "rate_limited" => "rate_limited",
        _ => "unknown",
    }
}

fn secret_audit_line(provider_id: &str, allowed: bool, reason: &str, ts: u128) -> String {
    let payload = serde_json::json!({
        "event": "secret-read",
        "ts": ts,
        "provider": canonical_audit_provider(provider_id),
        "allowed": allowed,
        "reason": canonical_audit_reason(reason),
    });
    format!("[lunerylab][audit] {payload}")
}

/// Append one structured single-line record for every secret-read attempt.
/// Provider ids are an allowlist projection, not request text, and JSON
/// escaping prevents CR/LF/control characters from forging extra records.
pub(crate) fn audit_secret_read(provider_id: &str, allowed: bool, reason: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    eprintln!("{}", secret_audit_line(provider_id, allowed, reason, ts));
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

fn read_keychain_password_direct(provider_id: &str) -> Result<String, ProviderSecretReadError> {
    let entry = provider_entry(provider_id).map_err(|_| ProviderSecretReadError::Unavailable)?;
    entry.get_password().map_err(classify_keychain_read_error)
}

#[derive(Serialize, Deserialize)]
struct KeychainReadHelperResponse {
    state: String,
    secret: Option<String>,
}

/// Hidden child-process entrypoint. The parent never calls an uncancellable OS
/// keychain API in-process: if the native store stalls, it kills this helper at
/// the deadline or lifecycle shutdown boundary.
pub(crate) fn run_keychain_read_helper_if_requested() -> bool {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(KEYCHAIN_READ_HELPER_ARG) {
        return false;
    }
    let provider_id = args.next().unwrap_or_default();
    let response = if validate_provider_id(&provider_id).is_err() {
        KeychainReadHelperResponse {
            state: "unknown".to_string(),
            secret: None,
        }
    } else {
        match read_keychain_password_direct(&provider_id) {
            Ok(secret) => KeychainReadHelperResponse {
                state: "present".to_string(),
                secret: Some(secret),
            },
            Err(ProviderSecretReadError::Missing) => KeychainReadHelperResponse {
                state: "absent".to_string(),
                secret: None,
            },
            Err(_) => KeychainReadHelperResponse {
                state: "unknown".to_string(),
                secret: None,
            },
        }
    };
    if let Ok(payload) = serde_json::to_vec(&response) {
        let _ = std::io::stdout().write_all(&payload);
        let _ = std::io::stdout().flush();
    }
    true
}

fn run_bounded_keychain_helper(
    mut command: Command,
    timeout: Duration,
) -> Result<Vec<u8>, ProviderSecretReadError> {
    let runtime = secret_runtime();
    let epoch = runtime.capture_epoch()?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let child = command
        .spawn()
        .map_err(|_| ProviderSecretReadError::Unavailable)?;
    let (helper_id, child) = runtime.register_helper(child);
    let deadline = Instant::now() + timeout;
    let result = loop {
        if !runtime.is_current(epoch) || Instant::now() >= deadline {
            let mut slot = child
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            break Err(ProviderSecretReadError::Unavailable);
        }
        let exited = {
            let mut slot = child
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match slot
                .as_mut()
                .and_then(|child| child.try_wait().ok())
                .flatten()
            {
                Some(_) => slot.take(),
                None => None,
            }
        };
        if let Some(mut child) = exited {
            let mut bytes = Vec::new();
            if let Some(mut stdout) = child.stdout.take() {
                if stdout.read_to_end(&mut bytes).is_err() {
                    let _ = child.wait();
                    break Err(ProviderSecretReadError::Unavailable);
                }
            }
            break match child.wait() {
                Ok(status) if status.success() => Ok(bytes),
                _ => Err(ProviderSecretReadError::Unavailable),
            };
        }
        if runtime.wait_or_cancel(Duration::from_millis(10), epoch) {
            continue;
        }
    };
    runtime.unregister_helper(helper_id);
    result
}

fn read_keychain_password(provider_id: &str) -> Result<String, ProviderSecretReadError> {
    let executable = std::env::current_exe().map_err(|_| ProviderSecretReadError::Unavailable)?;
    let mut command = Command::new(executable);
    command.arg(KEYCHAIN_READ_HELPER_ARG).arg(provider_id);
    let payload = run_bounded_keychain_helper(command, SECRET_BACKEND_TIMEOUT)?;
    let response: KeychainReadHelperResponse =
        serde_json::from_slice(&payload).map_err(|_| ProviderSecretReadError::Unavailable)?;
    match (response.state.as_str(), response.secret) {
        ("present", Some(secret)) if !secret.is_empty() => Ok(secret),
        ("absent", _) => Err(ProviderSecretReadError::Missing),
        _ => Err(ProviderSecretReadError::Unavailable),
    }
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

fn bump_provider_status_revision() {
    static REVISION: AtomicU64 = AtomicU64::new(0);
    #[cfg(test)]
    if std::env::var_os("LUNERY_RUNTIME_DIR").is_none() {
        return;
    }
    let Ok(runtime) = crate::profile::profile_runtime_root_path() else {
        return;
    };
    if std::fs::create_dir_all(&runtime).is_err() {
        return;
    }
    let sequence = REVISION.fetch_add(1, Ordering::AcqRel) + 1;
    let revision = format!("{}-{sequence}", std::process::id());
    let target = runtime.join("provider-status.revision");
    let temporary = runtime.join(format!(
        ".provider-status.revision.{}.{}.tmp",
        std::process::id(),
        sequence
    ));
    if std::fs::write(&temporary, revision).is_err() {
        return;
    }
    #[cfg(windows)]
    let _ = std::fs::remove_file(&target);
    if std::fs::rename(&temporary, &target).is_err() {
        let _ = std::fs::remove_file(temporary);
    }
}

fn run_presence_worker(reader: PresenceReader) {
    let _guard = PresenceWorkerGuard;
    let runtime = secret_runtime();
    let Ok(epoch) = runtime.capture_epoch() else {
        return;
    };
    loop {
        if !runtime.is_current(epoch) {
            return;
        }
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
        let generation = secret_read_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .generations
            .get(&provider_id)
            .copied()
            .unwrap_or(0);
        let outcome = reader(&provider_id);
        if !runtime.is_current(epoch) {
            return;
        }
        let mut state = secret_read_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.generations.get(&provider_id).copied().unwrap_or(0) == generation {
            let presence = match outcome {
                Ok(_) => KeychainSecretState::Present,
                Err(ProviderSecretReadError::Missing) => KeychainSecretState::Absent,
                Err(_) => KeychainSecretState::Unknown,
            };
            state.presence.insert(
                provider_id.clone(),
                CachedPresence {
                    state: presence,
                    expires_at: Instant::now() + SECRET_PRESENCE_TTL,
                },
            );
        }
        state.presence_queued.remove(&provider_id);
        drop(state);
        bump_provider_status_revision();
    }
}

fn spawn_presence_worker(reader: PresenceReader) -> Result<(), String> {
    let runtime = secret_runtime();
    let mut worker = runtime
        .presence_worker
        .lock()
        .map_err(|_| "Secret presence worker registry is poisoned".to_string())?;
    if runtime.cancelled.load(Ordering::Acquire) {
        return Err("Secret runtime is shutting down".to_string());
    }
    if worker.as_ref().is_some_and(|worker| !worker.is_finished()) {
        return Ok(());
    }
    if let Some(finished) = worker.take() {
        let _ = finished.join();
    }
    *worker = Some(
        std::thread::Builder::new()
            .name("lunery-secret-presence".to_string())
            .spawn(move || run_presence_worker(reader))
            .map_err(|error| format!("Could not start secret presence worker: {error}"))?,
    );
    Ok(())
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
        return KeychainSecretState::Unknown;
    }
    let (snapshot, spawn_worker) = {
        let mut state = secret_read_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cached = state.presence.get(provider_id).copied();
        let snapshot = cached
            .map(|presence| presence.state)
            .unwrap_or(KeychainSecretState::Unknown);
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
    if spawn_worker && spawn_presence_worker(reader).is_err() {
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
    if secret_runtime().cancelled.load(Ordering::Acquire) {
        return Err(ProviderSecretReadError::Unavailable);
    }
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
        let (mut finished, timeout) = inflight
            .cv
            .wait_timeout_while(guard, SECRET_FOLLOWER_TIMEOUT, |slot| {
                slot.is_none() && !secret_runtime().cancelled.load(Ordering::Acquire)
            })
            .map_err(|_| ProviderSecretReadError::Unavailable)?;
        if finished.is_none()
            && (timeout.timed_out() || secret_runtime().cancelled.load(Ordering::Acquire))
        {
            *finished = Some(Err(ProviderSecretReadError::Unavailable));
            inflight.cv.notify_all();
            drop(finished);
            let mut state = secret_read_state()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state
                .inflight
                .get(provider_id)
                .is_some_and(|current| Arc::ptr_eq(current, &inflight))
            {
                state.inflight.remove(provider_id);
                let generation = state
                    .generations
                    .entry(provider_id.to_string())
                    .or_default();
                *generation = generation.wrapping_add(1);
            }
            return Err(ProviderSecretReadError::Unavailable);
        }
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
            invalidate_provider_secret_cache_inner(&provider_id, Some(KeychainSecretState::Absent));
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
        run_bounded_keychain_helper, secret_audit_line, secret_read_state, secret_runtime,
        KeychainSecretState, PresenceReader, ProviderSecretMutationError, ProviderSecretReadError,
        SECRET_FAILURE_LIMIT, SECRET_READ_LIMIT,
    };
    use crate::test_global_lock;
    use keyring_core::Error as KeyringError;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    fn reset_secret_state() {
        secret_runtime().reset();
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
    fn audit_record_allowlists_provider_and_cannot_forge_lines() {
        let injected = "openai\r\nprovider=anthropic raw-secret";
        let line = secret_audit_line(injected, false, "bad\r\nreason", 42);
        assert_eq!(line.lines().count(), 1);
        assert!(line.len() < 256);
        assert!(line.contains("\"provider\":\"unknown\""));
        assert!(line.contains("\"reason\":\"unknown\""));
        assert!(!line.contains("raw-secret"));

        let canonical = secret_audit_line("openai", true, "ok", 43);
        assert!(canonical.contains("\"provider\":\"openai\""));
        assert!(canonical.contains("\"reason\":\"ok\""));
    }

    #[cfg(unix)]
    #[test]
    fn helper_timeout_and_shutdown_are_strictly_bounded() {
        let _g = test_global_lock();
        reset_secret_state();

        let mut timeout_command = Command::new("/bin/sh");
        timeout_command.args(["-c", "exec sleep 30"]);
        let started = Instant::now();
        assert_eq!(
            run_bounded_keychain_helper(timeout_command, Duration::from_millis(100))
                .expect_err("helper must time out"),
            ProviderSecretReadError::Unavailable
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(secret_runtime().helpers.lock().unwrap().is_empty());

        let worker = std::thread::spawn(|| {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "exec sleep 30"]);
            run_bounded_keychain_helper(command, Duration::from_secs(30))
        });
        for _ in 0..100 {
            if !secret_runtime().helpers.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(secret_runtime().helpers.lock().unwrap().len(), 1);
        let shutdown_started = Instant::now();
        secret_runtime().shutdown();
        assert!(shutdown_started.elapsed() < Duration::from_secs(1));
        assert_eq!(
            worker.join().unwrap().expect_err("shutdown cancels helper"),
            ProviderSecretReadError::Unavailable
        );
        assert!(secret_runtime().helpers.lock().unwrap().is_empty());
        secret_runtime().reset();
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
        let runtime_dir = std::env::temp_dir().join(format!(
            "lunery-secret-revision-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        std::env::set_var("LUNERY_RUNTIME_DIR", &runtime_dir);
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
            KeychainSecretState::Unknown
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
            assert_eq!(caller.join().unwrap(), KeychainSecretState::Unknown);
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
        assert!(runtime_dir.join("provider-status.revision").is_file());
        std::env::remove_var("LUNERY_RUNTIME_DIR");
        let _ = std::fs::remove_dir_all(runtime_dir);
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
    fn timed_out_follower_detaches_generation_and_late_leader_cannot_cache() {
        let _g = test_global_lock();
        reset_secret_state();
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let entered_leader = Arc::clone(&entered);
        let release_leader = Arc::clone(&release);
        let leader = std::thread::spawn(move || {
            resolve_provider_secret_with("blocked", Instant::now(), |_| {
                entered_leader.wait();
                release_leader.wait();
                Ok("stale".to_string())
            })
        });
        entered.wait();

        let started = Instant::now();
        assert_eq!(
            resolve_provider_secret_with("blocked", Instant::now(), |_| {
                panic!("follower must not call backend")
            })
            .expect_err("follower deadline"),
            ProviderSecretReadError::Unavailable
        );
        assert!(started.elapsed() >= Duration::from_secs(2));
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(
            secret_read_state()
                .lock()
                .unwrap()
                .generations
                .get("blocked"),
            Some(&1)
        );

        release.wait();
        assert_eq!(leader.join().unwrap().unwrap(), "stale");
        let fresh =
            resolve_provider_secret_with("blocked", Instant::now(), |_| Ok("fresh".to_string()))
                .unwrap();
        assert_eq!(fresh, "fresh");
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
