use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::engine_lifecycle::EngineLifecycle;
use crate::llama_resident::LlamaResident;
#[cfg(test)]
use crate::model_residency::PersistentRegistration;
use crate::{kill_stale_pid_if_matches, reserve_local_port, residency_global, wait_for_port_while};
#[cfg(test)]
use std::process::Child;

/// Process-global snapshot of the active embedded engine, so the no-arg
/// `desktop_runtime_status()` (called by the bridge `/status` route) can report
/// the live endpoint without threading Tauri State through the bridge.
/// Mirrors the HTTP_CLIENT OnceLock pattern.
static LLAMA_ENGINE_INFO: OnceLock<Mutex<Option<LlamaEngineInfo>>> = OnceLock::new();

struct LlamaModelDeleteLease {
    lease_id: String,
    expires_at: Instant,
}

#[derive(Default)]
struct LlamaModelState {
    starting_path: Option<String>,
    delete_leases: HashMap<String, LlamaModelDeleteLease>,
}

static LLAMA_MODEL_STATE: OnceLock<Mutex<LlamaModelState>> = OnceLock::new();
const LLAMA_MODEL_DELETE_LEASE_TTL: Duration = Duration::from_secs(60);

fn llama_model_state() -> &'static Mutex<LlamaModelState> {
    LLAMA_MODEL_STATE.get_or_init(|| Mutex::new(LlamaModelState::default()))
}

fn normalize_llama_model_path(value: &str) -> String {
    let path = PathBuf::from(value);
    if let Ok(canonical) = std::fs::canonicalize(&path) {
        return canonical.to_string_lossy().to_string();
    }
    path.parent()
        .and_then(|parent| std::fs::canonicalize(parent).ok())
        .and_then(|parent| path.file_name().map(|name| parent.join(name)))
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

pub(crate) fn acquire_llama_model_delete_lease(
    model_path: &str,
    lease_id: &str,
) -> Result<(), String> {
    acquire_llama_model_delete_lease_at(model_path, lease_id, Instant::now())
}

fn acquire_llama_model_delete_lease_at(
    model_path: &str,
    lease_id: &str,
    now: Instant,
) -> Result<(), String> {
    if lease_id.is_empty() || lease_id.len() > 128 {
        return Err("Invalid llama model deletion lease".to_string());
    }
    let model_path = normalize_llama_model_path(model_path);
    let mut state = llama_model_state()
        .lock()
        .map_err(|_| "Llama model state lock poisoned".to_string())?;
    state
        .delete_leases
        .retain(|_, lease| lease.expires_at > now);
    if state.starting_path.as_deref() == Some(model_path.as_str()) {
        return Err("Text model is starting".to_string());
    }
    if let Some(existing) = state.delete_leases.get(&model_path) {
        if existing.lease_id != lease_id {
            return Err("Text model is already being deleted".to_string());
        }
    }
    state.delete_leases.insert(
        model_path,
        LlamaModelDeleteLease {
            lease_id: lease_id.to_string(),
            expires_at: now + LLAMA_MODEL_DELETE_LEASE_TTL,
        },
    );
    Ok(())
}

pub(crate) fn release_llama_model_delete_lease(model_path: &str, lease_id: &str) {
    let model_path = normalize_llama_model_path(model_path);
    if let Ok(mut state) = llama_model_state().lock() {
        if state
            .delete_leases
            .get(&model_path)
            .map(|lease| lease.lease_id.as_str())
            == Some(lease_id)
        {
            state.delete_leases.remove(&model_path);
        }
    }
}

struct LlamaModelStartGuard {
    model_path: String,
}

impl LlamaModelStartGuard {
    fn acquire(model_path: &str) -> Result<Self, String> {
        Self::acquire_at(model_path, Instant::now())
    }

    fn acquire_at(model_path: &str, now: Instant) -> Result<Self, String> {
        let model_path = normalize_llama_model_path(model_path);
        let mut state = llama_model_state()
            .lock()
            .map_err(|_| "Llama model state lock poisoned".to_string())?;
        state
            .delete_leases
            .retain(|_, lease| lease.expires_at > now);
        if state.delete_leases.contains_key(&model_path) {
            return Err("Text model is being deleted".to_string());
        }
        state.starting_path = Some(model_path.clone());
        Ok(Self { model_path })
    }
}

impl Drop for LlamaModelStartGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = llama_model_state().lock() {
            if state.starting_path.as_deref() == Some(self.model_path.as_str()) {
                state.starting_path = None;
            }
        }
    }
}

// Fields are written here (start/stop) and read by the bridge `/status` path
// (`desktop_runtime_status()`) plus `bridge_start_llama` / `/llama-status`.
#[derive(Clone)]
pub(crate) struct LlamaEngineInfo {
    pub(crate) endpoint: String,
    pub(crate) model_path: String,
    pub(crate) model_id: String,
}

pub(crate) fn llama_engine_slot() -> &'static Mutex<Option<LlamaEngineInfo>> {
    LLAMA_ENGINE_INFO.get_or_init(|| Mutex::new(None))
}

#[derive(Serialize)]
pub(crate) struct LlamaServerStatus {
    running: bool,
    endpoint: Option<String>,
    model_path: Option<String>,
    model_id: Option<String>,
}

fn validate_model_alias(model_id: String) -> Result<String, String> {
    let model_id = model_id.trim().to_string();
    if model_id.is_empty() {
        return Err("model_id is required".to_string());
    }
    if model_id.len() > 512
        || model_id
            .chars()
            .any(|character| character.is_control() || character == ',')
    {
        return Err("model_id is not a valid llama.cpp alias".to_string());
    }
    Ok(model_id)
}

// ---------------------------------------------------------------------------
// Bridge-thread engine controller
//
// The HTTP bridge is the only product control surface for llama.cpp. Keeping a
// single child slot avoids drift between direct Tauri commands and the private
// Next -> bridge API.
// ---------------------------------------------------------------------------

static LLAMA_LIFECYCLE: EngineLifecycle = EngineLifecycle::new("llama-server.pid");

#[cfg(test)]
fn llama_bridge_child() -> &'static Mutex<Option<Child>> {
    LLAMA_LIFECYCLE.child_slot()
}

#[cfg(test)]
fn llama_residency_slot() -> &'static Mutex<Option<PersistentRegistration>> {
    LLAMA_LIFECYCLE.residency_slot()
}

fn pid_lockfile_path() -> Option<PathBuf> {
    LLAMA_LIFECYCLE.pid_lockfile_path()
}

fn prepare_llama_start() -> u64 {
    let epoch = LLAMA_LIFECYCLE.prepare_start();
    llama_engine_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    epoch
}

fn clear_llama_info_if_model(model_path: &str) {
    let mut slot = llama_engine_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot
        .as_ref()
        .is_some_and(|info| info.model_path == model_path)
    {
        *slot = None;
    }
}

#[cfg(test)]
fn cleanup_llama_exit_if_current(epoch: u64, model_path: &str, registration_id: &str) -> bool {
    if !LLAMA_LIFECYCLE.cleanup_exit_if_current(epoch, registration_id) {
        return false;
    }
    clear_llama_info_if_model(model_path);
    true
}

fn monitor_llama_exit(
    epoch: u64,
    model_path: String,
    registration_id: String,
) -> Result<(), String> {
    LLAMA_LIFECYCLE.monitor_exit(epoch, registration_id, move || {
        clear_llama_info_if_model(&model_path);
    })
}

/// Resolve the bundled engine dir without an AppHandle (bridge threads have none).
fn bridge_engine_root() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().ok();
    let dev_cwd = cfg!(debug_assertions)
        .then(std::env::current_dir)
        .transpose()
        .map_err(|err| format!("cwd: {err}"))?;
    crate::engine_paths::resolve_engine_path(
        executable.as_deref(),
        &[],
        dev_cwd.as_deref(),
        cfg!(debug_assertions),
        std::path::Path::is_dir,
    )
    .ok_or_else(|| "Bundled llama.cpp engine was not found".to_string())
}

/// Start the embedded llama.cpp server through the private HTTP bridge.
pub(crate) fn bridge_start_llama(
    model_path: String,
    model_id: String,
) -> Result<LlamaServerStatus, String> {
    let model_path = model_path.trim().to_string();
    let model_id = validate_model_alias(model_id)?;
    if model_path.is_empty() {
        return Err("model_path is required".to_string());
    }
    if !PathBuf::from(&model_path).is_file() {
        return Err(format!("Model file not found: {model_path}"));
    }
    let model_path = PathBuf::from(&model_path)
        .canonicalize()
        .map_err(|err| format!("Could not resolve model path: {err}"))?
        .to_string_lossy()
        .to_string();
    let _start_guard = LLAMA_LIFECYCLE.start_guard();
    let _model_start_guard = LlamaModelStartGuard::acquire(&model_path)?;

    let current = llama_engine_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let alive = LLAMA_LIFECYCLE.child_is_alive()?;
    if alive {
        if let Some(info) = current
            .as_ref()
            .filter(|info| info.model_path == model_path && info.model_id == model_id)
        {
            return Ok(LlamaServerStatus {
                running: true,
                endpoint: Some(info.endpoint.clone()),
                model_path: Some(model_path),
                model_id: Some(model_id),
            });
        }
    }
    let my_epoch = prepare_llama_start();

    let root = bridge_engine_root()?;
    let bin = root.join(if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    });
    if !bin.exists() {
        return Err(format!(
            "Bundled llama-server is missing: {}",
            bin.display()
        ));
    }

    let registration = residency_global()
        .ok_or_else(|| "Residency manager is unavailable".to_string())?
        .register_persistent(LlamaResident::new(&model_path, bridge_stop_llama))
        .map_err(|err| format!("Not enough VRAM for this model — {err}"))?;

    let bin_abspath = bin.to_string_lossy().to_string();
    let pid_lockfile = pid_lockfile_path();
    if let Some(ref lockfile) = pid_lockfile {
        kill_stale_pid_if_matches(lockfile, &bin_abspath);
    }

    let port = reserve_local_port()?;
    let endpoint = format!("http://127.0.0.1:{port}");
    let child = Command::new(&bin)
        .arg("--model")
        .arg(&model_path)
        .arg("--alias")
        .arg(&model_id)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--no-webui")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("Could not start llama-server: {err}"))?;

    LLAMA_LIFECYCLE
        .install_child(my_epoch, child, &bin)
        .map_err(|_| "Llama start was superseded".to_string())?;

    // Readiness gate. On failure we must NOT leave the just-spawned child in the
    // global slot (the old behaviour leaked a zombie + a stale lockfile and the
    // next start would refuse to proceed). Roll back fully: kill+wait the child,
    // clear the child + engine slots, and remove the lockfile — but only while
    // we are still the current epoch, so we never tear down a concurrent start.
    if let Err(err) = wait_for_port_while(port, || LLAMA_LIFECYCLE.current_epoch() == my_epoch) {
        if LLAMA_LIFECYCLE.rollback_if_current(my_epoch, None) {
            if let Ok(mut slot) = llama_engine_slot().lock() {
                *slot = None;
            }
        }
        return Err(err);
    }

    // Commit the engine slot only after readiness succeeds, and only if we are
    // still current.
    if LLAMA_LIFECYCLE.current_epoch() == my_epoch {
        let mut engine_slot = llama_engine_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if LLAMA_LIFECYCLE.current_epoch() != my_epoch {
            return Err("Llama start was superseded".to_string());
        }
        *engine_slot = Some(LlamaEngineInfo {
            endpoint: endpoint.clone(),
            model_path: model_path.clone(),
            model_id: model_id.clone(),
        });
        drop(engine_slot);
        let registration_id = registration.id().to_string();
        LLAMA_LIFECYCLE
            .commit_registration(my_epoch, registration)
            .map_err(|_| "Llama start was superseded".to_string())?;
        if let Err(error) =
            monitor_llama_exit(my_epoch, model_path.clone(), registration_id.clone())
        {
            LLAMA_LIFECYCLE.rollback_if_current(my_epoch, Some(&registration_id));
            clear_llama_info_if_model(&model_path);
            return Err(error);
        }
    } else {
        return Err("Llama start was superseded".to_string());
    }

    Ok(LlamaServerStatus {
        running: true,
        endpoint: Some(endpoint),
        model_path: Some(model_path),
        model_id: Some(model_id),
    })
}

pub(crate) fn bridge_stop_llama() {
    LLAMA_LIFECYCLE.stop();
    *llama_engine_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_llama_model_delete_lease, acquire_llama_model_delete_lease_at, bridge_stop_llama,
        cleanup_llama_exit_if_current, llama_bridge_child, llama_engine_slot, llama_residency_slot,
        prepare_llama_start, release_llama_model_delete_lease, validate_model_alias,
        LlamaEngineInfo, LlamaModelStartGuard, LLAMA_LIFECYCLE,
    };
    use crate::llama_resident::LlamaResident;
    use crate::model_residency::ResidencyManager;
    use crate::test_global_lock;
    use std::ffi::OsString;
    use std::sync::Arc;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    struct RuntimeDirRestore(Option<OsString>);

    impl Drop for RuntimeDirRestore {
        fn drop(&mut self) {
            if let Some(value) = &self.0 {
                std::env::set_var("LUNERY_RUNTIME_DIR", value);
            } else {
                std::env::remove_var("LUNERY_RUNTIME_DIR");
            }
        }
    }

    #[test]
    fn model_alias_accepts_exact_ids_and_rejects_llama_alias_lists() {
        assert_eq!(
            validate_model_alias(" imported:llama-cpp:qwen-3 ".to_string())
                .expect("valid explicit id"),
            "imported:llama-cpp:qwen-3"
        );
        assert!(validate_model_alias("".to_string()).is_err());
        assert!(validate_model_alias("first,second".to_string()).is_err());
        assert!(validate_model_alias("bad\nalias".to_string()).is_err());
    }

    #[test]
    fn model_delete_lease_and_start_admission_are_mutually_exclusive() {
        let _g = test_global_lock();
        let model_path = std::env::temp_dir().join("lunery-llama-delete-lease.gguf");
        let model_path = model_path.to_string_lossy().to_string();

        acquire_llama_model_delete_lease(&model_path, "delete-lease")
            .expect("acquire delete lease");
        assert!(LlamaModelStartGuard::acquire(&model_path).is_err());
        release_llama_model_delete_lease(&model_path, "delete-lease");

        let start = LlamaModelStartGuard::acquire(&model_path).expect("admit start");
        assert!(acquire_llama_model_delete_lease(&model_path, "racing-delete").is_err());
        drop(start);
        acquire_llama_model_delete_lease(&model_path, "racing-delete")
            .expect("start completion releases admission");
        release_llama_model_delete_lease(&model_path, "racing-delete");
    }

    #[test]
    fn same_id_renewal_blocks_llama_start_past_original_expiry() {
        let _g = test_global_lock();
        let model_path = std::env::temp_dir()
            .join("lunery-llama-renewed-delete-lease.gguf")
            .to_string_lossy()
            .to_string();
        let t0 = Instant::now();
        acquire_llama_model_delete_lease_at(&model_path, "renew", t0).expect("initial lease");
        acquire_llama_model_delete_lease_at(&model_path, "renew", t0 + Duration::from_secs(59))
            .expect("same-id renewal");

        assert!(
            LlamaModelStartGuard::acquire_at(&model_path, t0 + Duration::from_secs(61)).is_err()
        );
        assert!(acquire_llama_model_delete_lease_at(
            &model_path,
            "different-owner",
            t0 + Duration::from_secs(61),
        )
        .is_err());
        release_llama_model_delete_lease(&model_path, "renew");
    }

    #[cfg(unix)]
    #[test]
    fn missing_model_lease_canonicalizes_a_symlinked_parent() {
        let _g = test_global_lock();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("lunery-llama-lease-symlink-{nonce}"));
        let physical = root.join("physical");
        let logical = root.join("logical");
        std::fs::create_dir_all(&physical).expect("create physical root");
        std::os::unix::fs::symlink(&physical, &logical).expect("create logical root symlink");
        let logical_model = logical.join("pending.gguf").to_string_lossy().to_string();
        let physical_model = physical.join("pending.gguf").to_string_lossy().to_string();

        acquire_llama_model_delete_lease(&logical_model, "symlink-delete")
            .expect("acquire missing model lease");
        assert!(LlamaModelStartGuard::acquire(&physical_model).is_err());
        release_llama_model_delete_lease(&logical_model, "symlink-delete");
        drop(LlamaModelStartGuard::acquire(&physical_model).expect("release canonical lease"));

        std::fs::remove_dir_all(root).expect("remove fixture");
    }

    // bridge_stop_llama must kill AND reap (wait) — the old code only killed,
    // leaving a zombie. We can't observe "reaped" directly, but we can assert it
    // clears the slot and the process is gone.
    #[cfg(unix)]
    #[test]
    fn bridge_stop_llama_clears_and_reaps_child() {
        let _g = test_global_lock();
        let _runtime_dir_restore = RuntimeDirRestore(std::env::var_os("LUNERY_RUNTIME_DIR"));
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        std::env::set_var(
            "LUNERY_RUNTIME_DIR",
            std::env::temp_dir().join(format!("lunerylab-llama-stop-{nonce}")),
        );
        let child = std::process::Command::new("sleep")
            .arg("30")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn sleep");
        *llama_bridge_child().lock().unwrap() = Some(child);

        bridge_stop_llama();

        assert!(
            llama_bridge_child().lock().unwrap().is_none(),
            "stop must clear the child slot"
        );
    }

    #[cfg(unix)]
    #[test]
    fn stale_exit_cleanup_does_not_clear_new_runtime_state() {
        let _g = test_global_lock();
        let _runtime_dir_restore = RuntimeDirRestore(std::env::var_os("LUNERY_RUNTIME_DIR"));
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let runtime_dir =
            std::env::temp_dir().join(format!("lunerylab-llama-stale-monitor-{nonce}"));
        std::fs::create_dir_all(&runtime_dir).expect("create runtime fixture");
        std::env::set_var("LUNERY_RUNTIME_DIR", &runtime_dir);
        let pid_lockfile = runtime_dir.join("llama-server.pid");
        std::fs::write(&pid_lockfile, "replacement").expect("create pid lock fixture");

        let model_path = std::env::temp_dir().join(format!("lunery-current-{nonce}.gguf"));
        std::fs::File::create(&model_path)
            .and_then(|file| file.set_len(1024 * 1024))
            .expect("create model fixture");
        let model_path = model_path.to_string_lossy().to_string();
        let residency = Arc::new(ResidencyManager::new(1));
        let registration = residency
            .register_persistent(LlamaResident::new(&model_path, bridge_stop_llama))
            .expect("register replacement residency");
        let registration_id = registration.id().to_string();
        *llama_residency_slot().lock().unwrap() = Some(registration);
        *llama_engine_slot().lock().unwrap() = Some(LlamaEngineInfo {
            endpoint: "http://127.0.0.1:2".to_string(),
            model_path: model_path.clone(),
            model_id: "replacement-model".to_string(),
        });
        let stale_epoch = LLAMA_LIFECYCLE.next_epoch();
        LLAMA_LIFECYCLE.next_epoch();
        assert!(
            !cleanup_llama_exit_if_current(stale_epoch, &model_path, &registration_id),
            "stale exit cleanup must lose the epoch claim"
        );
        assert_eq!(
            llama_engine_slot()
                .lock()
                .unwrap()
                .as_ref()
                .map(|info| info.model_path.as_str()),
            Some(model_path.as_str()),
            "stale monitor must preserve replacement engine info"
        );
        assert_eq!(
            llama_residency_slot()
                .lock()
                .unwrap()
                .as_ref()
                .map(|registration| registration.id()),
            Some(registration_id.as_str()),
            "stale monitor must preserve replacement residency"
        );
        assert!(
            pid_lockfile.exists(),
            "stale monitor must preserve replacement pid lockfile"
        );

        bridge_stop_llama();
        let _ = std::fs::remove_file(model_path);
        let _ = std::fs::remove_dir_all(runtime_dir);
    }

    #[cfg(unix)]
    #[test]
    fn model_switch_unregisters_old_residency_before_new_child_exists() {
        let _g = test_global_lock();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let old_path = std::env::temp_dir().join(format!("lunery-old-{nonce}.gguf"));
        let new_path = std::env::temp_dir().join(format!("lunery-new-{nonce}.gguf"));
        std::fs::File::create(&old_path)
            .and_then(|file| file.set_len(1024 * 1024))
            .expect("create old model fixture");
        std::fs::File::create(&new_path)
            .and_then(|file| file.set_len(1024 * 1024))
            .expect("create new model fixture");

        let residency = Arc::new(ResidencyManager::new(1));
        let old_registration = residency
            .register_persistent(LlamaResident::new(
                old_path.to_str().expect("utf8 old path"),
                bridge_stop_llama,
            ))
            .expect("register old residency");
        *llama_residency_slot().lock().unwrap() = Some(old_registration);
        *llama_engine_slot().lock().unwrap() = Some(LlamaEngineInfo {
            endpoint: "http://127.0.0.1:1".to_string(),
            model_path: old_path.to_string_lossy().to_string(),
            model_id: "old-model".to_string(),
        });
        *llama_bridge_child().lock().unwrap() = Some(
            std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("spawn old child"),
        );

        prepare_llama_start();
        assert!(llama_engine_slot().lock().unwrap().is_none());
        assert!(llama_bridge_child().lock().unwrap().is_none());

        *llama_bridge_child().lock().unwrap() = Some(
            std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("spawn replacement child"),
        );
        *llama_engine_slot().lock().unwrap() = Some(LlamaEngineInfo {
            endpoint: "http://127.0.0.1:2".to_string(),
            model_path: new_path.to_string_lossy().to_string(),
            model_id: "replacement-model".to_string(),
        });
        let replacement_registration = residency
            .register_persistent(LlamaResident::new(
                new_path.to_str().expect("utf8 new path"),
                bridge_stop_llama,
            ))
            .expect("register replacement residency");
        *llama_residency_slot().lock().unwrap() = Some(replacement_registration);
        let replacement_alive = llama_bridge_child()
            .lock()
            .unwrap()
            .as_mut()
            .expect("replacement child remains registered")
            .try_wait()
            .expect("inspect replacement child")
            .is_none();
        assert!(
            replacement_alive,
            "stale residency killed replacement child"
        );

        prepare_llama_start();
        let _ = std::fs::remove_file(old_path);
        let _ = std::fs::remove_file(new_path);
    }
}
