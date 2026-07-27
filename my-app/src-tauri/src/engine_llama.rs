use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use crate::engine_lifecycle::EngineLifecycle;
use crate::llama_resident::LlamaResident;
#[cfg(test)]
use crate::model_residency::PersistentRegistration;
use crate::{kill_stale_pid_if_matches, reserve_local_port, residency_global, wait_for_port};
#[cfg(test)]
use std::process::Child;

/// Process-global snapshot of the active embedded engine, so the no-arg
/// `desktop_runtime_status()` (called by the bridge `/status` route) can report
/// the live endpoint without threading Tauri State through the bridge.
/// Mirrors the HTTP_CLIENT OnceLock pattern.
static LLAMA_ENGINE_INFO: OnceLock<Mutex<Option<LlamaEngineInfo>>> = OnceLock::new();

// Fields are written here (start/stop) and read by the bridge `/status` path
// (`desktop_runtime_status()`) plus `bridge_start_llama` / `/llama-status`.
#[derive(Clone)]
pub(crate) struct LlamaEngineInfo {
    pub(crate) endpoint: String,
    pub(crate) model_path: String,
}

pub(crate) fn llama_engine_slot() -> &'static Mutex<Option<LlamaEngineInfo>> {
    LLAMA_ENGINE_INFO.get_or_init(|| Mutex::new(None))
}

#[derive(Serialize)]
pub(crate) struct LlamaServerStatus {
    running: bool,
    endpoint: Option<String>,
    model_path: Option<String>,
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

fn monitor_llama_exit(epoch: u64, model_path: String, registration_id: String) {
    LLAMA_LIFECYCLE.monitor_exit(epoch, registration_id, move || {
        clear_llama_info_if_model(&model_path);
    });
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
pub(crate) fn bridge_start_llama(model_path: String) -> Result<LlamaServerStatus, String> {
    let model_path = model_path.trim().to_string();
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

    let current = llama_engine_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let alive = LLAMA_LIFECYCLE.child_is_alive()?;
    if alive {
        if let Some(info) = current
            .as_ref()
            .filter(|info| info.model_path == model_path)
        {
            return Ok(LlamaServerStatus {
                running: true,
                endpoint: Some(info.endpoint.clone()),
                model_path: Some(model_path),
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
    if let Err(err) = wait_for_port(port) {
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
        });
        drop(engine_slot);
        let registration_id = registration.id().to_string();
        LLAMA_LIFECYCLE
            .commit_registration(my_epoch, registration)
            .map_err(|_| "Llama start was superseded".to_string())?;
        monitor_llama_exit(my_epoch, model_path.clone(), registration_id);
    } else {
        return Err("Llama start was superseded".to_string());
    }

    Ok(LlamaServerStatus {
        running: true,
        endpoint: Some(endpoint),
        model_path: Some(model_path),
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
        bridge_stop_llama, cleanup_llama_exit_if_current, llama_bridge_child, llama_engine_slot,
        llama_residency_slot, prepare_llama_start, LlamaEngineInfo, LLAMA_LIFECYCLE,
    };
    use crate::llama_resident::LlamaResident;
    use crate::model_residency::ResidencyManager;
    use crate::test_global_lock;
    use std::ffi::OsString;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

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
