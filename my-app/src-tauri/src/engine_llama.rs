use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use crate::llama_resident::LlamaResident;
use crate::model_residency::PersistentRegistration;
use crate::profile::profile_runtime_root_path;
use crate::{
    current_llama_epoch, kill_stale_pid_if_matches, next_llama_epoch, reserve_local_port,
    residency_global, wait_for_port, write_pid_lockfile,
};

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

static LLAMA_BRIDGE_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static LLAMA_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static LLAMA_RESIDENCY: OnceLock<Mutex<Option<PersistentRegistration>>> = OnceLock::new();
fn llama_bridge_child() -> &'static Mutex<Option<Child>> {
    LLAMA_BRIDGE_CHILD.get_or_init(|| Mutex::new(None))
}

fn llama_start_lock() -> &'static Mutex<()> {
    LLAMA_START_LOCK.get_or_init(|| Mutex::new(()))
}

fn llama_residency_slot() -> &'static Mutex<Option<PersistentRegistration>> {
    LLAMA_RESIDENCY.get_or_init(|| Mutex::new(None))
}

fn pid_lockfile_path() -> Option<PathBuf> {
    profile_runtime_root_path()
        .ok()
        .map(|runtime| runtime.join("llama-server.pid"))
}

fn stop_previous_llama_for_switch() -> Result<(), String> {
    // Keep the lifecycle reservation until the old child is fully reaped, then
    // release it before the replacement can reserve budget or spawn.
    let registration = llama_residency_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    llama_engine_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();

    let mut child_guard = llama_bridge_child()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(child) = child_guard.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *child_guard = None;
    if let Some(lockfile) = pid_lockfile_path() {
        let _ = std::fs::remove_file(lockfile);
    }
    drop(child_guard);
    drop(registration);
    Ok(())
}

fn monitor_llama_exit(epoch: u64, model_path: String, registration_id: String) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(250));
        if current_llama_epoch() != epoch {
            return;
        }
        let exited = {
            let mut child_slot = llama_bridge_child()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(child) = child_slot.as_mut() else {
                return;
            };
            match child.try_wait() {
                Ok(Some(_)) => {
                    *child_slot = None;
                    true
                }
                Ok(None) => false,
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    *child_slot = None;
                    true
                }
            }
        };
        if !exited {
            continue;
        }
        if current_llama_epoch() != epoch {
            return;
        }
        let mut slot = llama_engine_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot
            .as_ref()
            .map(|info| info.model_path == model_path)
            .unwrap_or(false)
        {
            *slot = None;
        }
        drop(slot);
        let registration = {
            let mut slot = llama_residency_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if slot
                .as_ref()
                .map(|registration| registration.id() == registration_id)
                .unwrap_or(false)
            {
                slot.take()
            } else {
                None
            }
        };
        drop(registration);
        if let Some(lockfile) = pid_lockfile_path() {
            let _ = std::fs::remove_file(lockfile);
        }
        return;
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
    let _start_guard = llama_start_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let current = llama_engine_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let alive = {
        let mut child_guard = llama_bridge_child()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        child_guard
            .as_mut()
            .map(|child| child.try_wait().map(|status| status.is_none()))
            .transpose()
            .map_err(|err| err.to_string())?
            .unwrap_or(false)
    };
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
    stop_previous_llama_for_switch()?;

    // We are committing to spawn a new child — bump the epoch so any stale
    // residency-teardown / rollback from a previous start no-ops, then capture
    // our own epoch for the rollback guard below.
    next_llama_epoch();
    let my_epoch = current_llama_epoch();

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
    let mut child = Command::new(&bin)
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

    {
        let mut child_guard = llama_bridge_child()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current_llama_epoch() != my_epoch {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Llama start was superseded".to_string());
        }
        if let Some(ref lockfile) = pid_lockfile {
            write_pid_lockfile(lockfile, child.id(), &bin);
        }
        *child_guard = Some(child);
    }

    // Readiness gate. On failure we must NOT leave the just-spawned child in the
    // global slot (the old behaviour leaked a zombie + a stale lockfile and the
    // next start would refuse to proceed). Roll back fully: kill+wait the child,
    // clear the child + engine slots, and remove the lockfile — but only while
    // we are still the current epoch, so we never tear down a concurrent start.
    if let Err(err) = wait_for_port(port) {
        if current_llama_epoch() == my_epoch {
            if let Ok(mut guard) = llama_bridge_child().lock() {
                if current_llama_epoch() == my_epoch {
                    if let Some(child) = guard.as_mut() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    *guard = None;
                }
            }
            if let Ok(mut slot) = llama_engine_slot().lock() {
                *slot = None;
            }
            if let Some(ref lockfile) = pid_lockfile {
                let _ = std::fs::remove_file(lockfile);
            }
        }
        return Err(err);
    }

    // Commit the engine slot only after readiness succeeds, and only if we are
    // still current.
    if current_llama_epoch() == my_epoch {
        let mut engine_slot = llama_engine_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current_llama_epoch() != my_epoch {
            return Err("Llama start was superseded".to_string());
        }
        *engine_slot = Some(LlamaEngineInfo {
            endpoint: endpoint.clone(),
            model_path: model_path.clone(),
        });
        drop(engine_slot);
        let registration_id = registration.id().to_string();
        let mut residency_slot = llama_residency_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current_llama_epoch() != my_epoch {
            return Err("Llama start was superseded".to_string());
        }
        *residency_slot = Some(registration);
        drop(residency_slot);
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
    // Invalidate any in-flight start's epoch first.
    next_llama_epoch();
    let registration = llama_residency_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    let mut guard = llama_bridge_child()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
        let _ = child.wait(); // reap (mirrors bridge_stop_mlx / bridge_stop_sd)
    }
    *guard = None;
    drop(guard);
    drop(registration);
    *llama_engine_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    if let Some(lockfile) = pid_lockfile_path() {
        let _ = std::fs::remove_file(lockfile);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        bridge_stop_llama, llama_bridge_child, llama_engine_slot, llama_residency_slot,
        stop_previous_llama_for_switch, LlamaEngineInfo,
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

        stop_previous_llama_for_switch().expect("stop old model");
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

        stop_previous_llama_for_switch().expect("cleanup replacement");
        let _ = std::fs::remove_file(old_path);
        let _ = std::fs::remove_file(new_path);
    }
}
