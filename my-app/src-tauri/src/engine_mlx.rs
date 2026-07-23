use serde::Serialize;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::mlx_resident::MlxResident;
use crate::model_residency::PersistentRegistration;
use crate::profile::profile_runtime_root_path;
use crate::{
    current_mlx_epoch, invalidate_mlx_epoch_if_current, kill_stale_pid_if_matches, next_mlx_epoch,
    reserve_local_port, residency_global, write_pid_lockfile,
};

// ---------------------------------------------------------------------------
// Embedded SwiftLM (Swift+MLX) text engine — Module 4 (macOS Apple Silicon).
//
// Resident OpenAI-compatible server, mirrors the llama.cpp bridge controller
// but with its OWN slot/global/locator (no LLAMA_* reuse). Differs from llama:
// the `--model` arg is an HF repo id (or path), NOT a local file — SwiftLM
// self-downloads+caches it, so there is no is_file() check, and first start can
// take minutes (multi-GB download) → a generous bounded readiness wait.
// On Windows the SwiftLM binary is absent (MLX is Apple-Silicon-only): start
// fails fast, mlx never becomes ready, capability-router falls back to llama.
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub(crate) struct MlxEngineInfo {
    pub(crate) endpoint: String,
    pub(crate) model: String,
}

static MLX_ENGINE_INFO: OnceLock<Mutex<Option<MlxEngineInfo>>> = OnceLock::new();
pub(crate) fn mlx_engine_slot() -> &'static Mutex<Option<MlxEngineInfo>> {
    MLX_ENGINE_INFO.get_or_init(|| Mutex::new(None))
}

static MLX_BRIDGE_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static MLX_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static MLX_RESIDENCY: OnceLock<Mutex<Option<PersistentRegistration>>> = OnceLock::new();
fn mlx_bridge_child() -> &'static Mutex<Option<Child>> {
    MLX_BRIDGE_CHILD.get_or_init(|| Mutex::new(None))
}

fn mlx_start_lock() -> &'static Mutex<()> {
    MLX_START_LOCK.get_or_init(|| Mutex::new(()))
}

fn mlx_residency_slot() -> &'static Mutex<Option<PersistentRegistration>> {
    MLX_RESIDENCY.get_or_init(|| Mutex::new(None))
}

fn pid_lockfile_path() -> Option<PathBuf> {
    profile_runtime_root_path()
        .ok()
        .map(|runtime| runtime.join("mlx-server.pid"))
}

/// Coarse SwiftLM first-start progress. SwiftLM emits ONLY human-readable
/// download/load text on stdout/stderr before it binds its port (no flag, no
/// endpoint), so this is a best-effort line parse — good enough to replace a
/// 20-minute silent hang with a live "downloading NN%". Its own slot, never
/// the engine slot (which is set only when the server is actually ready).
#[derive(Clone, Serialize)]
pub(crate) struct MlxProgress {
    /// "downloading" | "loading" — coarse phase from the log line.
    pub(crate) phase: String,
    /// 0–100 when a percentage was seen, else None.
    pub(crate) percent: Option<u8>,
}

static MLX_PROGRESS: OnceLock<Mutex<Option<MlxProgress>>> = OnceLock::new();
pub(crate) fn mlx_progress_slot() -> &'static Mutex<Option<MlxProgress>> {
    MLX_PROGRESS.get_or_init(|| Mutex::new(None))
}

/// Async MLX activation job. Set by `bridge_start_mlx` (returns immediately
/// after spawning the child + monitor thread). Cleared by `bridge_stop_mlx`
/// and overwritten on each new activation. Surfaced to the UI via `/mlx-status`
/// so the long (multi-GB) first-pull can be polled instead of blocking a Next
/// 30 s request timeout.
#[derive(Clone, Serialize)]
pub(crate) struct MlxJobStatus {
    pub(crate) job_id: String,
    /// "starting" | "downloading" | "loading" | "ready" | "error"
    pub(crate) phase: String,
    pub(crate) percent: Option<u8>,
    pub(crate) error: Option<String>,
    model: String,
}

static MLX_JOB: OnceLock<Mutex<Option<MlxJobStatus>>> = OnceLock::new();
pub(crate) fn mlx_job_slot() -> &'static Mutex<Option<MlxJobStatus>> {
    MLX_JOB.get_or_init(|| Mutex::new(None))
}

fn set_mlx_job(job: Option<MlxJobStatus>) {
    if let Ok(mut g) = mlx_job_slot().lock() {
        *g = job;
    }
}

fn update_mlx_job_phase(phase: &str, error: Option<String>) {
    if let Ok(mut g) = mlx_job_slot().lock() {
        if let Some(job) = g.as_mut() {
            job.phase = phase.to_string();
            if let Some(e) = error {
                job.error = Some(e);
            }
        }
    }
}

/// Atomic "phase + percent" update used by the stdout/stderr drain threads.
/// Previously the drainer called `set_mlx_progress` + `update_mlx_job_phase` +
/// poked `job.percent` separately — three lock/unlock cycles with a window
/// where readers saw inconsistent (new phase, old percent). This bundles them.
fn update_mlx_progress(phase: &str, percent: Option<u8>) {
    if let Ok(mut g) = mlx_progress_slot().lock() {
        *g = Some(MlxProgress {
            phase: phase.to_string(),
            percent,
        });
    }
    if let Ok(mut g) = mlx_job_slot().lock() {
        if let Some(job) = g.as_mut() {
            job.phase = phase.to_string();
            job.percent = percent;
        }
    }
}

/// Ack payload — `bridge_start_mlx` returns this immediately so the bridge
/// caller (and Next API route) does not block on the multi-minute first pull.
#[derive(Serialize)]
pub(crate) struct MlxStartAck {
    job_id: String,
    /// "starting" | "already_running"
    status: &'static str,
    endpoint: Option<String>,
    model: Option<String>,
}

fn set_mlx_progress(phase: &str, percent: Option<u8>) {
    if let Ok(mut g) = mlx_progress_slot().lock() {
        *g = Some(MlxProgress {
            phase: phase.to_string(),
            percent,
        });
    }
}

fn clear_mlx_progress() {
    if let Ok(mut g) = mlx_progress_slot().lock() {
        *g = None;
    }
}

/// Best-effort parse of one SwiftLM stdout/stderr line → (phase, percent).
/// Scans whitespace/bracket-delimited tokens for a trailing `NN%` and keys
/// off `download`/`fetch`/`load`/`model`. Lines that match nothing return
/// None and leave the last known progress untouched.
fn parse_mlx_line(line: &str) -> Option<(&'static str, Option<u8>)> {
    let lower = line.to_ascii_lowercase();
    let percent = lower
        .split(|c: char| c.is_whitespace() || c == '(' || c == '[')
        .find_map(|tok| {
            let t = tok.trim_end_matches([',', ')', ']', '.']);
            t.strip_suffix('%').and_then(|n| n.parse::<u16>().ok())
        })
        .and_then(|n| u8::try_from(n.min(100)).ok());
    let phase = if lower.contains("download") || lower.contains("fetch") || percent.is_some() {
        "downloading"
    } else if lower.contains("load") || lower.contains("model") {
        "loading"
    } else {
        return None;
    };
    Some((phase, percent))
}

/// Validate the SwiftLM `--model` argument before spawning. SwiftLM treats it
/// as either a Hugging Face repo id (which it self-downloads) or a local path,
/// so an unvalidated value could smuggle CLI flags (`--port`), trigger a
/// multi-GB download of an attacker-chosen repo, or — if a local path — escape
/// the models cache. Accept ONLY:
///   1. an HF repo id of the form `owner/name` (restricted character set), or
///   2. a canonicalised local path with no `..` traversal that resolves under
///      the models root.
///
/// Mirrors `engine_sd::sd_model_path_allowed` for the local-path branch.
fn mlx_model_arg_allowed(model: &str) -> bool {
    if model.is_empty() || model.len() > 256 {
        return false;
    }
    // Reject anything that looks like a CLI flag injected as the model value.
    if model.starts_with('-') {
        return false;
    }

    // Branch 1: HF repo id "owner/name" (exactly two non-empty segments,
    // restricted to alphanumerics and -_. — the HF-allowed id charset).
    let mut segments = model.split('/');
    if let (Some(owner), Some(name), None) = (segments.next(), segments.next(), segments.next()) {
        let valid_segment = |s: &str| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        };
        if valid_segment(owner) && valid_segment(name) {
            return true;
        }
    }

    // Branch 2: a local path that canonicalises under the models root with no
    // parent-dir traversal.
    let path = PathBuf::from(model);
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    if let Ok(canon) = path.canonicalize() {
        if let Ok(roots) = crate::download::canonical_models_roots() {
            return roots.iter().any(|root| canon.starts_with(root));
        }
    }
    false
}

/// Locate the bundled SwiftLM dir without an AppHandle (bridge threads have
/// none). Mirrors `bridge_engine_root()` but targets the `mlx/` subdir.
fn bridge_mlx_engine_root() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().ok();
    let dev_cwd = cfg!(debug_assertions)
        .then(std::env::current_dir)
        .transpose()
        .map_err(|err| format!("cwd: {err}"))?;
    crate::engine_paths::resolve_engine_path(
        executable.as_deref(),
        &["mlx"],
        dev_cwd.as_deref(),
        cfg!(debug_assertions),
        std::path::Path::is_dir,
    )
    .ok_or_else(|| "Bundled SwiftLM (MLX) engine was not found".to_string())
}

/// Block until the port accepts a TCP connection or the deadline passes.
/// MLX first start may download a multi-GB model, so the deadline is generous
/// (the bridge handler runs on a detached per-connection thread; the Next
/// /api/desktop-runtime/mlx POST is expected to be slow on first activate).
fn wait_for_port_long(port: u16, max_secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(max_secs);
    let mut backoff = Duration::from_millis(200);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return true;
        }
        thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_secs(8));
    }
    false
}

/// Commit the "ready" state for an MLX activation, but ONLY while `epoch` is
/// still the current engine epoch. Every step re-checks the epoch (and the
/// engine-slot commit re-checks under the lock, serialising against a concurrent
/// `bridge_start_mlx` that writes the new child under the same child lock) so a
/// monitor whose model was superseded touches nothing.
fn mlx_commit_ready(epoch: u64, endpoint: &str, model: &str) {
    if current_mlx_epoch() != epoch {
        return;
    }
    if let Ok(mut slot) = mlx_engine_slot().lock() {
        if current_mlx_epoch() != epoch {
            return;
        }
        *slot = Some(MlxEngineInfo {
            endpoint: endpoint.to_string(),
            model: model.to_string(),
        });
    }
    if current_mlx_epoch() != epoch {
        return;
    }
    set_mlx_progress("ready", Some(100));
    if let Ok(mut g) = mlx_job_slot().lock() {
        if current_mlx_epoch() != epoch {
            return;
        }
        if let Some(job) = g.as_mut() {
            job.phase = "ready".to_string();
            job.percent = Some(100);
        }
    }
}

/// Handle a readiness timeout: kill the child this monitor spawned and mark the
/// job errored — but ONLY if `epoch` is still current. The child kill re-checks
/// the epoch under the child lock; because `bridge_start_mlx` writes the new
/// child while holding that same lock, this guarantees a stale monitor can never
/// kill the freshly-started replacement process.
fn mlx_finalize_timeout(epoch: u64, registration_id: &str) {
    if current_mlx_epoch() != epoch {
        return;
    }
    let mut child_slot = mlx_bridge_child()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if current_mlx_epoch() == epoch {
        if let Some(child) = child_slot.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *child_slot = None;
    }
    drop(child_slot);
    if current_mlx_epoch() != epoch {
        return;
    }
    let registration = {
        let mut slot = mlx_residency_slot()
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
    clear_mlx_progress();
    update_mlx_job_phase(
        "error",
        Some(
            "SwiftLM did not bind its port within 20 minutes. Check the model id \
             and your network — first pull can be multi-GB."
                .to_string(),
        ),
    );
}

fn monitor_mlx_exit(epoch: u64, model: String, registration_id: String) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(250));
        if current_mlx_epoch() != epoch {
            return;
        }
        let exited = {
            let mut child_slot = mlx_bridge_child()
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
        if !invalidate_mlx_epoch_if_current(epoch) {
            return;
        }
        let mut slot = mlx_engine_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot
            .as_ref()
            .map(|info| info.model == model)
            .unwrap_or(false)
        {
            *slot = None;
        }
        drop(slot);
        let registration = {
            let mut slot = mlx_residency_slot()
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
        clear_mlx_progress();
        update_mlx_job_phase("error", Some("SwiftLM exited unexpectedly".to_string()));
        if let Some(lockfile) = pid_lockfile_path() {
            let _ = std::fs::remove_file(lockfile);
        }
        return;
    });
}

/// Fire-and-forget MLX activation. Spawns SwiftLM + a monitor thread, then
/// returns immediately with an ack so the Next API request does not block on
/// the multi-GB first pull. Progress is surfaced via MLX_JOB / MLX_PROGRESS,
/// polled by the UI through `/mlx-status`.
pub(crate) fn bridge_start_mlx(model: String) -> Result<MlxStartAck, String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("model (HF repo id or path) is required".to_string());
    }
    // NOTE: no is_file() — `model` is an HF repo id SwiftLM self-downloads.
    // But it still must be a well-formed repo id or a models-root path, never an
    // arbitrary string that could inject CLI flags or escape the cache.
    if !mlx_model_arg_allowed(&model) {
        return Err(
            "model must be a Hugging Face repo id (owner/name) or a path under the models cache"
                .to_string(),
        );
    }
    let _start_guard = mlx_start_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    // Reject if already running this same model — short-circuit ack instead
    // of restarting (which would drop a hot multi-GB model from memory).
    {
        let mut child_guard = mlx_bridge_child()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let alive = child_guard
            .as_mut()
            .and_then(|child| child.try_wait().ok())
            .map(|status| status.is_none())
            .unwrap_or(false);
        if alive {
            let engine_model = mlx_engine_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
                .map(|info| info.model.clone());
            let job = mlx_job_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let same_model = engine_model
                .as_deref()
                .or_else(|| job.as_ref().map(|job| job.model.as_str()))
                .map(|active_model| active_model == model)
                .unwrap_or(false);
            if same_model {
                let endpoint = mlx_engine_slot()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .as_ref()
                    .map(|i| i.endpoint.clone());
                let job_id = job
                    .map(|job| job.job_id)
                    .unwrap_or_else(|| format!("mlx-{}", current_millis()));
                return Ok(MlxStartAck {
                    job_id,
                    status: "already_running",
                    endpoint,
                    model: Some(model),
                });
            }
        }
    }

    // Different model (or stopped) — tear down, restart. `bridge_stop_mlx`
    // bumps the engine epoch, so capture OUR epoch AFTER it: any monitor/drain
    // thread from the model we just stopped now holds a stale epoch and will
    // no-op instead of touching the process we are about to spawn.
    bridge_stop_mlx();
    let my_epoch = next_mlx_epoch();

    let root = bridge_mlx_engine_root()?;
    let bin = root.join("SwiftLM");
    if !bin.exists() {
        return Err(format!("Bundled SwiftLM is missing: {}", bin.display()));
    }
    let registration = residency_global()
        .ok_or_else(|| "Residency manager is unavailable".to_string())?
        .register_persistent(MlxResident::new(&model, 0, bridge_stop_mlx))
        .map_err(|err| format!("Not enough VRAM for this model — {err}"))?;

    let mlx_bin_abspath = bin.to_string_lossy().to_string();
    let pid_lockfile = pid_lockfile_path();
    if let Some(ref lockfile) = pid_lockfile {
        kill_stale_pid_if_matches(lockfile, &mlx_bin_abspath);
    }

    let port = reserve_local_port()?;
    let endpoint = format!("http://127.0.0.1:{port}");
    let job_id = format!("mlx-{}", current_millis());

    set_mlx_progress("downloading", None);
    set_mlx_job(Some(MlxJobStatus {
        job_id: job_id.clone(),
        phase: "starting".to_string(),
        percent: None,
        error: None,
        model: model.clone(),
    }));

    let mut child = match Command::new(&bin)
        .arg("--model")
        .arg(&model)
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(err) => {
            clear_mlx_progress();
            update_mlx_job_phase("error", Some(format!("Could not start SwiftLM: {err}")));
            return Err(format!("Could not start SwiftLM: {err}"));
        }
    };

    // CRITICAL ordering: take stdout/stderr BEFORE storing child in Mutex.
    // After insert the Mutex guard would need to be held just to take them,
    // and the drain threads need to outlive the lock. See README/PROCESS.md.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(out) = stdout {
        let ep = my_epoch;
        thread::spawn(move || {
            let reader = std::io::BufReader::new(out);
            for line in std::io::BufRead::lines(reader).map_while(Result::ok) {
                // A newer start/stop superseded us — stop writing the shared
                // progress/job slots so we don't clobber the new model's state.
                if current_mlx_epoch() != ep {
                    return;
                }
                if let Some((phase, pct)) = parse_mlx_line(&line) {
                    update_mlx_progress(phase, pct);
                }
            }
        });
    }
    if let Some(err) = stderr {
        let ep = my_epoch;
        thread::spawn(move || {
            let reader = std::io::BufReader::new(err);
            for line in std::io::BufRead::lines(reader).map_while(Result::ok) {
                if current_mlx_epoch() != ep {
                    return;
                }
                if let Some((phase, pct)) = parse_mlx_line(&line) {
                    update_mlx_progress(phase, pct);
                }
            }
        });
    }

    {
        let mut child_guard = mlx_bridge_child()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current_mlx_epoch() != my_epoch {
            let _ = child.kill();
            let _ = child.wait();
            return Err("MLX start was superseded".to_string());
        }
        if let Some(ref lockfile) = pid_lockfile {
            write_pid_lockfile(lockfile, child.id(), &bin);
        }
        *child_guard = Some(child);
    }
    let registration_id = registration.id().to_string();
    let mut residency_slot = mlx_residency_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if current_mlx_epoch() != my_epoch {
        return Err("MLX start was superseded".to_string());
    }
    *residency_slot = Some(registration);
    drop(residency_slot);

    // Background monitor — waits for port bind (up to 20 min) and finalises
    // MLX_JOB + mlx_engine_slot. The caller (bridge handler) returns ack
    // immediately, freeing the Next request. Every shared-state mutation is
    // epoch-gated (see `mlx_commit_ready` / `mlx_finalize_timeout`) so a stale
    // monitor from a superseded model can never kill the new process.
    let model_clone = model.clone();
    let endpoint_clone = endpoint.clone();
    let timeout_registration_id = registration_id.clone();
    thread::spawn(move || {
        if wait_for_port_long(port, 1200) {
            mlx_commit_ready(my_epoch, &endpoint_clone, &model_clone);
        } else {
            mlx_finalize_timeout(my_epoch, &timeout_registration_id);
        }
    });
    monitor_mlx_exit(my_epoch, model.clone(), registration_id);

    Ok(MlxStartAck {
        job_id,
        status: "starting",
        endpoint: Some(endpoint),
        model: Some(model),
    })
}

fn current_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub(crate) fn bridge_stop_mlx() {
    // Bump the epoch FIRST so any in-flight monitor / drain thread for the model
    // we are about to kill immediately sees itself as stale and stops touching
    // shared state (and crucially, stops short of killing a future process).
    next_mlx_epoch();

    let registration = mlx_residency_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    let mut guard = mlx_bridge_child()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
        let _ = child.wait(); // reap (mirrors bridge_stop_sd)
    }
    *guard = None;
    drop(guard);
    drop(registration);
    *mlx_engine_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    clear_mlx_progress();
    set_mlx_job(None);
    if let Some(lockfile) = pid_lockfile_path() {
        let _ = std::fs::remove_file(lockfile);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        mlx_bridge_child, mlx_commit_ready, mlx_engine_slot, mlx_finalize_timeout,
        mlx_model_arg_allowed,
    };
    use crate::{current_mlx_epoch, next_mlx_epoch, test_global_lock};

    #[cfg(unix)]
    fn spawn_fake_child() -> std::process::Child {
        std::process::Command::new("sleep")
            .arg("30")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn sleep")
    }

    #[test]
    fn model_arg_validation_accepts_repo_ids_rejects_injection() {
        assert!(mlx_model_arg_allowed("mlx-community/Llama-3-8B"));
        assert!(mlx_model_arg_allowed("owner/name.v2_q4"));
        // injection / traversal / malformed
        assert!(!mlx_model_arg_allowed(""));
        assert!(!mlx_model_arg_allowed("--port"));
        assert!(!mlx_model_arg_allowed("../../etc/passwd"));
        assert!(!mlx_model_arg_allowed("singletoken"));
        assert!(!mlx_model_arg_allowed("a/b/c"));
        assert!(!mlx_model_arg_allowed("owner/na me"));
        assert!(!mlx_model_arg_allowed(&"x".repeat(300)));
    }

    // The P0-01 regression: a stale monitor's timeout must NOT kill the process
    // that a newer start (model B) installed in the slot.
    #[cfg(unix)]
    #[test]
    fn stale_timeout_does_not_kill_new_child() {
        let _g = test_global_lock();
        let b = spawn_fake_child();
        let b_pid = b.id();
        *mlx_bridge_child().lock().unwrap() = Some(b);

        // Capture the (soon-to-be) stale epoch, then a newer start/stop bumps it.
        let stale = current_mlx_epoch();
        next_mlx_epoch();

        mlx_finalize_timeout(stale, "mlx:test");

        let mut guard = mlx_bridge_child().lock().unwrap();
        let still = guard.as_mut().expect("B must still be in the slot");
        assert_eq!(still.id(), b_pid, "slot must still hold B");
        assert!(
            still.try_wait().unwrap().is_none(),
            "B must still be alive — a stale monitor killed it"
        );
        let _ = still.kill();
        let _ = still.wait();
        *guard = None;
    }

    // The matching positive case: a CURRENT-epoch timeout does kill+reap its own
    // child and clears the slot.
    #[cfg(unix)]
    #[test]
    fn current_timeout_kills_and_clears_slot() {
        let _g = test_global_lock();
        let child = spawn_fake_child();
        *mlx_bridge_child().lock().unwrap() = Some(child);
        let ep = next_mlx_epoch();
        mlx_finalize_timeout(ep, "mlx:test");
        assert!(
            mlx_bridge_child().lock().unwrap().is_none(),
            "current-epoch timeout must clear the child slot"
        );
    }

    #[test]
    fn stale_commit_ready_does_not_set_slot() {
        let _g = test_global_lock();
        *mlx_engine_slot().lock().unwrap() = None;
        let stale = current_mlx_epoch();
        next_mlx_epoch();
        mlx_commit_ready(stale, "http://127.0.0.1:1", "owner/model");
        assert!(
            mlx_engine_slot().lock().unwrap().is_none(),
            "stale monitor must not commit the engine slot"
        );
    }
}
