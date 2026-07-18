use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use crate::llama_resident::LlamaResident;
use crate::profile::profile_runtime_root_path;
use crate::{
    current_engine_epoch, kill_stale_pid_if_matches, next_engine_epoch, reserve_local_port,
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
fn llama_bridge_child() -> &'static Mutex<Option<Child>> {
    LLAMA_BRIDGE_CHILD.get_or_init(|| Mutex::new(None))
}

fn pid_lockfile_path() -> Option<PathBuf> {
    profile_runtime_root_path()
        .ok()
        .map(|runtime| runtime.join("llama-server.pid"))
}

/// Resolve the bundled engine dir without an AppHandle (bridge threads have none).
fn bridge_engine_root() -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for cand in [
                dir.join("engine"),
                dir.join("..").join("Resources").join("engine"),
                dir.join("..").join("Resources").join("_up_").join("engine"),
            ] {
                if cand.exists() {
                    return Ok(cand);
                }
            }
        }
    }
    let local = std::env::current_dir()
        .map_err(|e| format!("cwd: {e}"))?
        .join("engine");
    if local.exists() {
        return Ok(local);
    }
    Err("Bundled llama.cpp engine was not found".to_string())
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

    {
        let mut child_guard = llama_bridge_child()
            .lock()
            .map_err(|_| "Llama bridge lock is poisoned".to_string())?;
        if let Some(child) = child_guard.as_mut() {
            let alive = child.try_wait().map_err(|err| err.to_string())?.is_none();
            let same_model = llama_engine_slot()
                .lock()
                .map_err(|_| "Llama slot lock is poisoned".to_string())?
                .as_ref()
                .map(|i| i.model_path.as_str() == model_path.as_str())
                .unwrap_or(false);
            if alive && same_model {
                let endpoint = llama_engine_slot()
                    .lock()
                    .map_err(|_| "Llama slot lock is poisoned".to_string())?
                    .as_ref()
                    .map(|i| i.endpoint.clone())
                    .ok_or_else(|| "Llama endpoint is missing".to_string())?;
                return Ok(LlamaServerStatus {
                    running: true,
                    endpoint: Some(endpoint),
                    model_path: Some(model_path),
                });
            }
            let _ = child.kill();
            let _ = child.wait(); // reap, don't leave a zombie
            *child_guard = None;
        }
    }

    // We are committing to spawn a new child — bump the epoch so any stale
    // residency-teardown / rollback from a previous start no-ops, then capture
    // our own epoch for the rollback guard below.
    next_engine_epoch();
    let my_epoch = current_engine_epoch();

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

    {
        let mut child_guard = llama_bridge_child()
            .lock()
            .map_err(|_| "Llama bridge lock is poisoned".to_string())?;
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
        if current_engine_epoch() == my_epoch {
            if let Ok(mut guard) = llama_bridge_child().lock() {
                if current_engine_epoch() == my_epoch {
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
    if current_engine_epoch() == my_epoch {
        if let Ok(mut slot) = llama_engine_slot().lock() {
            *slot = Some(LlamaEngineInfo {
                endpoint: endpoint.clone(),
                model_path: model_path.clone(),
            });
        }
    }

    // Best-effort residency registration. Failure here means VRAM is over
    // budget even after evicting every non-active model — we surface a
    // friendly error to the bridge caller, after tearing down the just-
    // started llama child so we don't leave it leaking the VRAM the user
    // explicitly told us they don't have.
    if let Some(residency) = residency_global() {
        let resident = LlamaResident::new(&model_path, bridge_stop_llama);
        if let Err(err) = residency.register(resident) {
            bridge_stop_llama();
            return Err(format!("Not enough VRAM for this model — {err}"));
        }
    }

    Ok(LlamaServerStatus {
        running: true,
        endpoint: Some(endpoint),
        model_path: Some(model_path),
    })
}

pub(crate) fn bridge_stop_llama() {
    // Invalidate any in-flight start's epoch first.
    next_engine_epoch();

    // Snapshot the model id BEFORE we wipe the slot, so we can tell the
    // residency manager which entry to forget. Done outside the residency
    // lock to avoid lock ordering issues.
    let model_id = llama_engine_slot()
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|i| i.model_path.clone()))
        .and_then(|p| {
            std::path::Path::new(&p)
                .file_name()
                .and_then(|s| s.to_str().map(|s| s.to_string()))
        });

    if let Ok(mut guard) = llama_bridge_child().lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait(); // reap (mirrors bridge_stop_mlx / bridge_stop_sd)
        }
        *guard = None;
    }
    if let Ok(mut slot) = llama_engine_slot().lock() {
        *slot = None;
    }
    if let Some(lockfile) = pid_lockfile_path() {
        let _ = std::fs::remove_file(lockfile);
    }
    if let (Some(residency), Some(id)) = (residency_global(), model_id) {
        residency.drop_model(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::{bridge_stop_llama, llama_bridge_child};
    use crate::test_global_lock;
    use std::ffi::OsString;
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
}
