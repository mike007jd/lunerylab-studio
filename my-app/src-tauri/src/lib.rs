mod download;
mod engine_llama;
mod engine_mlx;
mod engine_sd;
mod external_apps;
mod hardware;
mod http_bridge;
mod llama_resident;
mod mlx_resident;
mod model_residency;
mod profile;
mod sd_cpp_resident;
mod secrets;
mod security;
mod vram_probe;

use crate::download::{
    hf_download_cancel, hf_download_list, hf_download_start, hf_download_status, DownloadState,
};
use crate::engine_llama::{bridge_stop_llama, llama_engine_slot};
use crate::engine_mlx::{bridge_stop_mlx, mlx_engine_slot, mlx_job_slot, mlx_progress_slot};
use crate::engine_sd::{bridge_stop_sd, sd_binary_path};
use crate::external_apps::{is_lmstudio_installed, is_ollama_installed};
use crate::hardware::{cached_accel, detect_hardware, probe_local_runtime, AccelInfo};
use crate::http_bridge::start_desktop_bridge;
use crate::profile::{ensure_profile_dirs, profile_dirs, ProfileDirs, ProfileStorageDirs};
use crate::secrets::{delete_provider_secret, has_keychain_secret, save_provider_secret};
#[cfg(not(debug_assertions))]
use crate::security::bridge_token;

use model_residency::{ModelKind, ResidencyManager};
use serde::Serialize;
#[cfg(not(debug_assertions))]
use sha2::{Digest, Sha256};
#[cfg(not(debug_assertions))]
use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
#[cfg(not(debug_assertions))]
use std::io::Read;
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
#[cfg(not(debug_assertions))]
use std::process::Stdio;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
#[cfg(not(debug_assertions))]
use std::time::SystemTime;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------------------------------------------------------------------
// E6: Process-wide shared reqwest client — reqwest::Client is internally Arc,
// designed to be cloned/shared; avoids rebuilding (and losing connection pool)
// on every download task. Falls back to a fresh build if OnceLock races on
// first init, preserving the same Result-propagation semantics as before.
// ---------------------------------------------------------------------------
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn get_http_client() -> Result<reqwest::Client, reqwest::Error> {
    // Fast path: already initialized.
    if let Some(c) = HTTP_CLIENT.get() {
        return Ok(c.clone());
    }
    // Build a candidate (only happens once; concurrent first-downloads race here).
    let candidate = reqwest::Client::builder()
        .user_agent("Lunery Lab Desktop/1.0")
        .build()?;
    // set() returns Err(candidate) if another thread already set it — discard ours.
    let _ = HTTP_CLIENT.set(candidate);
    // Either we just set it or another thread did; either way it's initialized now.
    Ok(HTTP_CLIENT.get().expect("OnceLock set above").clone())
}

// ---------------------------------------------------------------------------
// Existing desktop server + keychain state
// ---------------------------------------------------------------------------

#[derive(Default)]
struct DesktopServerState {
    child: Mutex<Option<Child>>,
    #[cfg(unix)]
    process_group: Mutex<Option<u32>>,
    url: Mutex<Option<String>>,
    pid_lockfile: Mutex<Option<PathBuf>>,
    dev_bridge_file: Mutex<Option<PathBuf>>,
    booting: AtomicBool,
    /// Flipped by `shutdown` so the local-runtime watcher thread exits cleanly
    /// on app shutdown instead of being a daemon leak. The watcher reads this
    /// every 2s tick.
    watcher_cancel: Arc<AtomicBool>,
}

impl DesktopServerState {
    fn shutdown(&self) {
        self.watcher_cancel.store(true, Ordering::Relaxed);

        let mut child_guard = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(mut child) = child_guard.take() {
            #[cfg(unix)]
            let process_group = self
                .process_group
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            #[cfg(not(unix))]
            let process_group = None;
            terminate_desktop_process(&mut child, process_group);
        }
        drop(child_guard);

        let mut pid_lockfile_guard = self
            .pid_lockfile
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(path) = pid_lockfile_guard.take() {
            let _ = std::fs::remove_file(path);
        }
        drop(pid_lockfile_guard);

        let mut dev_bridge_guard = self
            .dev_bridge_file
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(path) = dev_bridge_guard.take() {
            let _ = std::fs::remove_file(path);
        }
        drop(dev_bridge_guard);

        let mut url_guard = self
            .url
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *url_guard = None;
    }
}

fn terminate_desktop_process(child: &mut Child, process_group: Option<u32>) {
    #[cfg(unix)]
    if let Some(group) = process_group {
        let group_arg = format!("-{group}");
        let _ = Command::new("kill").args(["-TERM", &group_arg]).status();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = Command::new("kill").args(["-KILL", &group_arg]).status();
        let _ = child.wait();
        return;
    }

    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .status();
        let _ = child.wait();
        return;
    }

    #[cfg(not(windows))]
    let _ = child.kill();
    #[cfg(not(windows))]
    let _ = child.wait();
}

impl Drop for DesktopServerState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Process-global handle to the ResidencyManager. Bridge threads (no Tauri
/// State) reach it through here; the Tauri builder also manages it as
/// `State<Arc<ResidencyManager>>` so #[tauri::command] handlers stay typed.
/// Both pointers refer to the same Arc.
static RESIDENCY_GLOBAL: OnceLock<Arc<ResidencyManager>> = OnceLock::new();
pub(crate) fn residency_global() -> Option<&'static Arc<ResidencyManager>> {
    RESIDENCY_GLOBAL.get()
}

#[derive(Serialize)]
struct DesktopRuntimeStatus {
    app: &'static str,
    mode: &'static str,
    local_first: bool,
    platform: &'static str,
    arch: &'static str,
    version: &'static str,
    profile_root: String,
    storage_dirs: ProfileStorageDirs,
    accel: AccelInfo,
    providers: Vec<ProviderConnectionStatus>,
    local_runtimes: Vec<LocalRuntimeStatus>,
    model_stores: Vec<ModelStoreStatus>,
}

#[derive(Serialize)]
struct ProviderConnectionStatus {
    id: &'static str,
    label: &'static str,
    auth: &'static str,
    configured: bool,
    source: &'static str,
    secret_store: &'static str,
}

#[derive(Serialize)]
struct LocalRuntimeStatus {
    id: String,
    label: String,
    endpoint: String,
    /// "ready" | "idle" | "downloading" | "ready-to-connect" | "configurable"
    status: String,
    /// True when the external runtime binary/app is installed on disk
    /// (probed via fixed paths). For embedded runtimes (llama-cpp / sd-cpp /
    /// mlx) this mirrors `available`. Unknown for "openai-compatible" → false.
    installed: bool,
}

#[derive(Serialize)]
struct ModelStoreStatus {
    id: &'static str,
    label: &'static str,
    path: String,
    available: bool,
}

#[derive(Serialize)]
struct DesktopServerStatus {
    url: String,
    port: u16,
}

#[cfg(debug_assertions)]
#[derive(Serialize)]
struct DesktopDevBridgeFile {
    url: String,
    token: String,
    pid: u32,
}

pub(crate) struct DesktopBridge {
    pub(crate) port: u16,
    pub(crate) token: String,
}

fn has_env_key(keys: &[&str]) -> bool {
    keys.iter().any(|key| std::env::var_os(key).is_some())
}

/// Monotonic process-lifecycle epoch shared by all local inference engines
/// (llama / mlx / sd). Every engine `start`/`stop` bumps it via
/// `next_engine_epoch()` and captures the returned value as "my epoch". The
/// background monitor / stdout-stderr drain threads spawned by a start compare
/// their captured epoch against `current_engine_epoch()` BEFORE mutating any
/// global child / job / slot or killing a process. A mismatch means a newer
/// start (or a stop) has superseded this thread, so it exits silently and never
/// touches shared state — this is what stops an old MLX monitor from killing the
/// freshly-started replacement process after a model switch.
///
/// A single global counter is enough: each engine only ever compares against its
/// own captured value, and a monotonic counter (unlike a PID) can never be
/// reused, so there is no ABA hazard.
static ENGINE_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Bump the shared engine epoch and return the new value (the caller's own
/// epoch for this start/stop).
pub(crate) fn next_engine_epoch() -> u64 {
    ENGINE_EPOCH.fetch_add(1, Ordering::SeqCst) + 1
}

/// Read the current shared engine epoch. Background threads compare this against
/// their captured epoch before mutating shared state.
pub(crate) fn current_engine_epoch() -> u64 {
    ENGINE_EPOCH.load(Ordering::SeqCst)
}

/// Process-wide serialization lock for tests that mutate the shared engine epoch
/// or the per-engine global child/slot singletons. cargo runs tests in parallel
/// by default; these singletons are shared, so concurrent engine-lifecycle tests
/// would race. Acquire this at the top of any such test.
#[cfg(test)]
pub(crate) fn test_global_lock() -> std::sync::MutexGuard<'static, ()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn reserve_local_port() -> Result<u16, String> {
    // Known accepted TOCTOU gap: the TcpListener is dropped here before the Node child
    // binds the port, leaving a narrow window where another process could claim it.
    // Accepted as low-probability in the single-user desktop context; tracked as a
    // known follow-up. Intentionally not refactored in D0.
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("Could not reserve local server port: {err}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| format!("Could not inspect local server port: {err}"))
}

#[cfg(not(debug_assertions))]
fn runtime_log_tail(log_path: &Path) -> String {
    let text = match std::fs::read_to_string(log_path) {
        Ok(value) => value,
        Err(err) => {
            return format!("Could not read runtime log {}: {err}", log_path.display());
        }
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "No runtime output was captured.".to_string();
    }
    let total = trimmed.chars().count();
    let mut tail: String = trimmed.chars().rev().take(4000).collect();
    tail = tail.chars().rev().collect();
    if total > 4000 {
        format!("...{tail}")
    } else {
        tail
    }
}

#[cfg(not(debug_assertions))]
fn wait_for_port_or_child_exit(
    port: u16,
    child: &mut Child,
    log_path: &Path,
    expected_session_hash: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut backoff = Duration::from_millis(200);
    let mut last_health_error = "Studio health check has not responded".to_string();
    while Instant::now() < deadline {
        match probe_desktop_health(port, expected_session_hash) {
            Ok(()) => return Ok(()),
            Err(err) => last_health_error = err,
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "Local Studio runtime exited before binding port {port} ({status}). \
                     Log: {}. Last output:\n{}",
                    log_path.display(),
                    runtime_log_tail(log_path)
                ));
            }
            Ok(None) => {}
            Err(err) => {
                return Err(format!(
                    "Could not inspect local Studio runtime process: {err}. Log: {}",
                    log_path.display()
                ));
            }
        }
        thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_secs(4));
    }
    Err(format!(
        "Local Studio runtime did not become healthy on port {port} within 30 seconds: \
         {last_health_error}. \
         Log: {}. Last output:\n{}",
        log_path.display(),
        runtime_log_tail(log_path)
    ))
}

#[cfg(not(debug_assertions))]
fn probe_desktop_health(port: u16, expected_session_hash: &str) -> Result<(), String> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500))
        .map_err(|err| format!("runtime unreachable: {err}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let request = format!(
        "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("health request failed: {err}"))?;

    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(size) => {
                raw.extend_from_slice(&chunk[..size]);
                if raw.len() > 64 * 1024 {
                    return Err("health response exceeded 64 KiB".to_string());
                }
            }
            Err(err) => return Err(format!("health response failed: {err}")),
        }
    }

    let response = String::from_utf8_lossy(&raw);
    let mut parts = response.splitn(2, "\r\n\r\n");
    let head = parts.next().unwrap_or("");
    let body = parts.next().unwrap_or("").trim();
    let status = head.lines().next().unwrap_or("");
    if !status.contains(" 200") {
        return Err(format!("health endpoint returned {status}"));
    }
    let payload: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("health response was invalid: {err}"))?;
    let session = payload
        .get("session")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if session != expected_session_hash {
        return Err("runtime identity check failed".to_string());
    }
    Ok(())
}

fn wait_for_port(port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut backoff = Duration::from_millis(200);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_secs(4));
    }
    Err(format!(
        "Local server did not bind port {port} within 30 seconds. \
         Check that the bundled binary is executable and that the requested \
         model file exists."
    ))
}

#[cfg(not(debug_assertions))]
fn desktop_runtime_log_path(dirs: &ProfileDirs) -> Result<PathBuf, String> {
    let log_dir = dirs.logs.clone();
    std::fs::create_dir_all(&log_dir).map_err(|err| {
        format!(
            "Could not create app log directory {}: {err}",
            log_dir.display()
        )
    })?;
    Ok(log_dir.join("desktop-runtime.log"))
}

/// Size cap + backup count for the desktop runtime log. Long-running sessions
/// used to append without bound; we rotate at 5 MiB and keep two backups
/// (desktop-runtime.log.1/.2) so logs stay useful without growing forever.
#[cfg(not(debug_assertions))]
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
#[cfg(not(debug_assertions))]
const MAX_LOG_BACKUPS: usize = 2;

/// Rotate the log if it has reached `max_bytes`: shift existing numbered backups
/// up (dropping the oldest) and move the current log to `.1`. Best-effort — a
/// failed rename must never block startup, so callers ignore the result.
#[cfg(any(test, not(debug_assertions)))]
fn rotate_log_if_needed(log_path: &Path, max_bytes: u64, max_backups: usize) {
    let size = match std::fs::metadata(log_path) {
        Ok(meta) => meta.len(),
        Err(_) => return, // no log yet
    };
    if size < max_bytes {
        return;
    }
    if max_backups == 0 {
        let _ = std::fs::remove_file(log_path);
        return;
    }
    // e.g. with 2 backups: .1 -> .2 (overwriting the oldest), then .log -> .1
    for i in (1..max_backups).rev() {
        let from = log_path.with_extension(format!("log.{i}"));
        let to = log_path.with_extension(format!("log.{}", i + 1));
        if from.exists() {
            let _ = std::fs::rename(&from, &to);
        }
    }
    let _ = std::fs::rename(log_path, log_path.with_extension("log.1"));
}

#[cfg(not(debug_assertions))]
fn prepare_desktop_runtime_log(
    log_path: &Path,
    port: u16,
    node_binary: &Path,
    runtime_js: &Path,
) -> Result<(std::fs::File, std::fs::File), String> {
    rotate_log_if_needed(log_path, MAX_LOG_BYTES, MAX_LOG_BACKUPS);
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|err| {
            format!(
                "Could not open desktop runtime log {}: {err}",
                log_path.display()
            )
        })?;
    writeln!(
        log,
        "\n[desktop-runtime] launch {:?} port={} node={} entry={}",
        SystemTime::now(),
        port,
        node_binary.display(),
        runtime_js.display()
    )
    .map_err(|err| format!("Could not write desktop runtime log header: {err}"))?;
    let stderr = log
        .try_clone()
        .map_err(|err| format!("Could not clone desktop runtime log handle: {err}"))?;
    Ok((log, stderr))
}

/// Stale-PID cleanup helper. Old behavior was a `ps -p <pid> -o comm=` probe
/// that matched on a substring of the process name — which meant any user
/// process with `node` or `llama-server` in its name (terminal, debugger,
/// editor extension) could be killed by accident after a PID-reuse cycle.
///
/// New format: the lockfile contains two lines —
///     {pid}\n
///     {abspath-of-the-binary-this-pid-was-spawned-from}\n
/// On cleanup we parse both, ask the OS for the running command of `pid`, and
/// only return Some(pid) when the running command's first token matches the
/// recorded abspath. Anything else (parse failure, OS probe failure, abspath
/// mismatch) returns None so we never kill an unrelated process.
fn read_pid_lockfile(lockfile: &Path) -> Option<(u32, String)> {
    let raw = std::fs::read_to_string(lockfile).ok()?;
    let mut lines = raw.lines();
    let pid: u32 = lines.next()?.trim().parse().ok()?;
    let abspath = lines.next()?.trim().to_string();
    if abspath.is_empty() {
        return None;
    }
    Some((pid, abspath))
}

fn command_line_matches_expected_binary(command: &str, expected_abspath: &str) -> bool {
    if expected_abspath.is_empty() {
        return false;
    }
    let command = command.trim();
    command
        .strip_prefix(expected_abspath)
        .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with(char::is_whitespace))
}

fn pid_matches_expected_binary(pid: u32, expected_abspath: &str) -> bool {
    #[cfg(not(windows))]
    {
        // `ps -o command=` returns argv0 + args. Compare the complete expected
        // argv0 prefix because packaged app paths contain spaces (for example
        // `/Applications/Lunery Lab Studio.app/...`). Splitting on whitespace
        // truncates those paths and prevents stale-child cleanup from working.
        let probe = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output();
        let Ok(out) = probe else { return false };
        if !out.status.success() {
            return false;
        }
        let cmd = match String::from_utf8(out.stdout) {
            Ok(s) => s,
            Err(_) => return false,
        };
        command_line_matches_expected_binary(&cmd, expected_abspath)
    }
    #[cfg(windows)]
    {
        // `wmic process where ProcessId=<pid> get ExecutablePath /value`
        // returns `ExecutablePath=C:\path\to\binary.exe`. Older Windows still
        // ships wmic; if it's missing the probe fails and we fall through to
        // false (no kill), which is the safe default.
        let probe = Command::new("wmic")
            .args([
                "process",
                "where",
                &format!("ProcessId={pid}"),
                "get",
                "ExecutablePath",
                "/value",
            ])
            .output();
        let Ok(out) = probe else { return false };
        if !out.status.success() {
            return false;
        }
        let cmd = match String::from_utf8(out.stdout) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let exec_path = cmd
            .lines()
            .find_map(|line| line.trim().strip_prefix("ExecutablePath="))
            .unwrap_or("")
            .trim();
        // Windows paths are case-insensitive.
        exec_path.eq_ignore_ascii_case(expected_abspath)
    }
}

fn kill_stale_pid_if_matches(lockfile: &Path, expected_abspath: &str) {
    if let Some((pid, recorded_abspath)) = read_pid_lockfile(lockfile) {
        // Two-layer match: lockfile abspath must equal the binary we're about
        // to spawn AND the running process at `pid` must report that same
        // abspath. Either disagreement → skip the kill.
        let abspath_matches = if cfg!(windows) {
            recorded_abspath.eq_ignore_ascii_case(expected_abspath)
        } else {
            recorded_abspath == expected_abspath
        };
        if abspath_matches && pid_matches_expected_binary(pid, expected_abspath) {
            #[cfg(not(windows))]
            {
                let _ = Command::new("kill").arg(pid.to_string()).status();
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .status();
            }
        }
    }
    // Always remove the lockfile — either we killed our predecessor, or the
    // file is stale / garbage / belongs to a now-foreign PID we won't touch.
    let _ = std::fs::remove_file(lockfile);
}

fn write_pid_lockfile(lockfile: &Path, pid: u32, abspath: &Path) {
    if let Some(parent) = lockfile.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let contents = format!("{}\n{}\n", pid, abspath.display());
    if let Err(err) = std::fs::write(lockfile, contents) {
        eprintln!("[lunerylab] Could not write pid lockfile: {err}");
    }
}

#[cfg(not(debug_assertions))]
fn desktop_server_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        for bundled in [
            resource_dir.join("desktop-server"),
            resource_dir.join("_up_").join("desktop-server"),
        ] {
            if bundled.exists() {
                return Ok(bundled);
            }
        }
    }

    let local = std::env::current_dir()
        .map_err(|err| format!("Could not resolve current directory: {err}"))?
        .join("desktop-server");
    if local.exists() {
        return Ok(local);
    }

    Err("Bundled desktop server resources were not found".to_string())
}

#[cfg(not(debug_assertions))]
const DESKTOP_SERVER_ENV_KEYS: &[&str] = &[
    "ECOM_STORAGE_DRIVER",
    "ECOM_MAX_UPLOAD_BYTES_PER_FILE",
    "ECOM_MAX_STORAGE_BYTES_PER_USER",
];

#[cfg(not(debug_assertions))]
fn trim_env_value(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        if (bytes[0] == b'"' && bytes[trimmed.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[trimmed.len() - 1] == b'\'')
        {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

#[cfg(not(debug_assertions))]
fn read_env_file(path: &Path, target_keys: &HashSet<&'static str>) -> HashMap<String, String> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let mut values = HashMap::new();
    for line in raw.lines() {
        let mut line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(stripped) = line.strip_prefix("export ") {
            line = stripped.trim_start();
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if !target_keys.contains(key) || values.contains_key(key) {
            continue;
        }
        values.insert(key.to_string(), trim_env_value(value));
    }
    values
}

/// Push the `.env.local` / `.env` pair for a SINGLE directory (no ancestor
/// walk). Precedence within a directory: `.env.local` before `.env`.
#[cfg(not(debug_assertions))]
fn push_env_dir_candidates(candidates: &mut Vec<PathBuf>, dir: &Path) {
    candidates.push(dir.join(".env.local"));
    candidates.push(dir.join(".env"));
}

#[cfg(not(debug_assertions))]
fn desktop_server_env_candidates(
    app: &AppHandle,
    server_root: &Path,
    app_dir: &Path,
    dirs: &ProfileDirs,
) -> Vec<PathBuf> {
    // SECURITY: only fixed, trusted directories are consulted for non-database
    // runtime toggles. The packaged database URL is owned by the desktop
    // launcher unless DATABASE_URL is set in the process environment. We do
    // NOT walk parent ancestors of cwd/exe/resource: walking up to the
    // filesystem root lets an attacker plant config in a parent sync folder.
    // Immediate, already-resolved dirs only.
    let mut candidates = Vec::new();
    push_env_dir_candidates(&mut candidates, &dirs.config);
    if let Ok(data_dir) = app.path().app_data_dir() {
        push_env_dir_candidates(&mut candidates, &data_dir);
    }
    if let Some(local_app_root) = server_root.parent() {
        push_env_dir_candidates(&mut candidates, local_app_root);
    }
    push_env_dir_candidates(&mut candidates, server_root);
    push_env_dir_candidates(&mut candidates, app_dir);
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            push_env_dir_candidates(&mut candidates, exe_dir);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        push_env_dir_candidates(&mut candidates, &resource_dir);
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

#[cfg(not(debug_assertions))]
fn resolve_desktop_server_env(
    app: &AppHandle,
    server_root: &Path,
    app_dir: &Path,
    dirs: &ProfileDirs,
) -> HashMap<String, String> {
    let target_keys: HashSet<&'static str> = DESKTOP_SERVER_ENV_KEYS.iter().copied().collect();
    let mut values = HashMap::new();
    for path in desktop_server_env_candidates(app, server_root, app_dir, dirs) {
        for (key, value) in read_env_file(&path, &target_keys) {
            if std::env::var_os(&key).is_none() && !values.contains_key(&key) {
                values.insert(key, value);
            }
        }
    }
    values
}

#[cfg(not(debug_assertions))]
fn desktop_media_dir(dirs: &ProfileDirs) -> Result<PathBuf, String> {
    let dir = dirs.media.clone();
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("Could not create desktop media directory: {err}"))?;
    Ok(dir)
}

fn provider_status(
    id: &'static str,
    label: &'static str,
    env_keys: &[&str],
) -> ProviderConnectionStatus {
    let env_configured = has_env_key(env_keys);
    let keychain_configured = has_keychain_secret(id);
    ProviderConnectionStatus {
        id,
        label,
        auth: "API key",
        configured: env_configured || keychain_configured,
        source: if env_configured {
            "environment"
        } else if keychain_configured {
            "system-keychain"
        } else {
            "none"
        },
        secret_store: "system-keychain",
    }
}

fn home_path(parts: &[&str]) -> Option<PathBuf> {
    let mut path = PathBuf::from(std::env::var_os("HOME")?);
    for part in parts {
        path.push(part);
    }
    Some(path)
}

fn model_store(id: &'static str, label: &'static str, parts: &[&str]) -> ModelStoreStatus {
    let path = home_path(parts);
    ModelStoreStatus {
        id,
        label,
        path: path
            .as_ref()
            .map(|value| value.display().to_string())
            .unwrap_or_else(|| "unavailable".to_string()),
        available: path.as_ref().is_some_and(|value| value.exists()),
    }
}

fn model_store_path(id: &'static str, label: &'static str, path: PathBuf) -> ModelStoreStatus {
    ModelStoreStatus {
        id,
        label,
        path: path.display().to_string(),
        available: path.exists(),
    }
}

fn unavailable_storage_dirs(reason: &str) -> ProfileStorageDirs {
    ProfileStorageDirs {
        config: reason.to_string(),
        data: reason.to_string(),
        pglite: reason.to_string(),
        media: reason.to_string(),
        models: reason.to_string(),
        logs: reason.to_string(),
        runtime: reason.to_string(),
    }
}

#[tauri::command]
fn desktop_runtime_status() -> DesktopRuntimeStatus {
    let profile = profile_dirs();
    let (profile_root, storage_dirs, profile_models) = match profile {
        Ok(dirs) => (
            dirs.root.display().to_string(),
            dirs.storage_dirs(),
            Some(dirs.models.clone()),
        ),
        Err(err) => {
            let message = format!("unavailable: {err}");
            (message.clone(), unavailable_storage_dirs(&message), None)
        }
    };
    DesktopRuntimeStatus {
        app: "Lunery Lab Studio",
        mode: "tauri-v2",
        local_first: true,
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        version: env!("CARGO_PKG_VERSION"),
        profile_root,
        storage_dirs,
        accel: cached_accel(),
        providers: vec![
            provider_status("openai", "OpenAI", &["OPENAI_API_KEY"]),
            provider_status("anthropic", "Anthropic", &["ANTHROPIC_API_KEY"]),
            provider_status(
                "gemini",
                "Google Gemini",
                &["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
            ),
            provider_status("openrouter", "OpenRouter", &["OPENROUTER_API_KEY"]),
            provider_status("minimax", "MiniMax", &["MINIMAX_API_KEY"]),
            provider_status("replicate", "Replicate", &["REPLICATE_API_TOKEN"]),
            provider_status("fal", "Fal", &["FAL_KEY"]),
            provider_status("together", "Together AI", &["TOGETHER_API_KEY"]),
            provider_status("fireworks", "Fireworks", &["FIREWORKS_API_KEY"]),
            provider_status("meshy", "Meshy", &["MESHY_API_KEY"]),
            provider_status("tripo", "Tripo", &["TRIPO_API_KEY"]),
            provider_status("openai-compatible", "OpenAI compatible", &[]),
        ],
        local_runtimes: {
            let mut runtimes: Vec<LocalRuntimeStatus> = Vec::new();
            let engine = llama_engine_slot().lock().ok().and_then(|g| g.clone());
            runtimes.push(LocalRuntimeStatus {
                id: "llama-cpp".to_string(),
                label: "Embedded llama.cpp".to_string(),
                endpoint: engine
                    .as_ref()
                    .map(|e| e.endpoint.clone())
                    .unwrap_or_else(|| "embedded".to_string()),
                status: if engine.is_some() {
                    "ready".to_string()
                } else {
                    "idle".to_string()
                },
                installed: true,
            });
            runtimes.push(LocalRuntimeStatus {
                id: "sd-cpp".to_string(),
                label: "Embedded stable-diffusion.cpp".to_string(),
                endpoint: "embedded-sdcpp".to_string(),
                status: if sd_binary_path().is_some() {
                    "ready".to_string()
                } else {
                    "idle".to_string()
                },
                installed: sd_binary_path().is_some(),
            });
            let mlx = mlx_engine_slot().lock().ok().and_then(|g| g.clone());
            let mlx_prog = mlx_progress_slot().lock().ok().and_then(|g| g.clone());
            runtimes.push(LocalRuntimeStatus {
                id: "mlx".to_string(),
                label: "Embedded MLX (Apple Silicon)".to_string(),
                endpoint: mlx
                    .as_ref()
                    .map(|e| e.endpoint.clone())
                    .unwrap_or_else(|| "embedded".to_string()),
                status: if mlx.is_some() {
                    "ready".to_string()
                } else if mlx_prog.is_some() {
                    "downloading".to_string()
                } else {
                    "idle".to_string()
                },
                installed: cfg!(target_os = "macos") && std::env::consts::ARCH == "aarch64",
            });
            runtimes.push(LocalRuntimeStatus {
                id: "ollama".to_string(),
                label: "Ollama".to_string(),
                endpoint: "http://127.0.0.1:11434".to_string(),
                status: "ready-to-connect".to_string(),
                installed: is_ollama_installed(),
            });
            runtimes.push(LocalRuntimeStatus {
                id: "lm-studio".to_string(),
                label: "LM Studio".to_string(),
                endpoint: "http://127.0.0.1:1234".to_string(),
                status: "ready-to-connect".to_string(),
                installed: is_lmstudio_installed(),
            });
            runtimes.push(LocalRuntimeStatus {
                id: "openai-compatible".to_string(),
                label: "OpenAI compatible".to_string(),
                endpoint: "custom localhost / LAN endpoint".to_string(),
                status: "configurable".to_string(),
                installed: false,
            });
            runtimes
        },
        model_stores: {
            let mut stores = vec![
                model_store(
                    "huggingface",
                    "Hugging Face Hub cache",
                    &[".cache", "huggingface", "hub"],
                ),
                model_store(
                    "lm-studio",
                    "LM Studio models",
                    &[".cache", "lm-studio", "models"],
                ),
            ];
            if let Some(models) = profile_models {
                stores.push(model_store_path("lunery", "Lunery model cache", models));
            }
            stores
        },
    }
}

#[cfg(not(debug_assertions))]
fn start_desktop_server(
    app: &AppHandle,
    state: &DesktopServerState,
    download_state: &Arc<DownloadState>,
) -> Result<DesktopServerStatus, String> {
    {
        let mut child_guard = state
            .child
            .lock()
            .map_err(|_| "Desktop server lock is poisoned".to_string())?;
        if let Some(child) = child_guard.as_mut() {
            if child.try_wait().map_err(|err| err.to_string())?.is_none() {
                let url = state
                    .url
                    .lock()
                    .map_err(|_| "Desktop server URL lock is poisoned".to_string())?
                    .clone()
                    .ok_or_else(|| "Desktop server URL is missing".to_string())?;
                let port = url
                    .rsplit(':')
                    .next()
                    .and_then(|value| value.parse::<u16>().ok())
                    .ok_or_else(|| "Desktop server port is invalid".to_string())?;
                return Ok(DesktopServerStatus { url, port });
            }
            *child_guard = None;
        }
    }

    let profile = profile_dirs()?;
    ensure_profile_dirs(&profile)?;

    let root = desktop_server_root(app)?;
    let app_dir = root.join("app");
    let server_js = app_dir.join("server.js");
    let runtime_js = app_dir.join("desktop-runtime-server.mjs");
    let node_binary = root
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });

    if !server_js.exists() {
        return Err(format!(
            "Desktop server entry is missing: {}",
            server_js.display()
        ));
    }
    if !runtime_js.exists() {
        return Err(format!(
            "Desktop runtime entry is missing: {}",
            runtime_js.display()
        ));
    }
    if !node_binary.exists() {
        return Err(format!(
            "Bundled Node runtime is missing: {}",
            node_binary.display()
        ));
    }
    let server_env = resolve_desktop_server_env(app, &root, &app_dir, &profile);

    // PID lockfile: kill any zombie server left by a previous crash.
    let node_bin_abspath = node_binary.to_string_lossy().to_string();
    let pid_lockfile = Some(profile.runtime.join("desktop-server.pid"));
    if let Some(ref lockfile) = pid_lockfile {
        // PID-reuse hardening: the lockfile now records both the previous PID
        // AND the absolute path of the binary it was spawned from. We kill the
        // PID only when (a) the lockfile's abspath equals the binary we're
        // about to spawn AND (b) the OS confirms that PID is currently
        // executing that same abspath. Either disagreement → leave the
        // process alone, just clean up the file.
        kill_stale_pid_if_matches(lockfile, &node_bin_abspath);
    }

    let port = reserve_local_port()?;
    let url = format!("http://127.0.0.1:{port}");
    let bridge = start_desktop_bridge(Arc::clone(download_state))?;
    let media_dir = desktop_media_dir(&profile)?;
    let pglite_dir = profile.pglite.clone();
    let migrations_dir = app_dir.join("prisma").join("migrations");
    // Public asset root of the bundled server. `public/samples/*` is copied
    // next to server.js, so today cwd resolution happens to work — but pin it
    // explicitly so first-launch sample seeding never depends on the server's
    // working directory. `lib/server/sample-projects.ts` reads this, with a
    // `cwd/public` fallback for `next dev` and tests.
    let public_dir = app_dir.join("public");
    let log_path = desktop_runtime_log_path(&profile)?;
    let session_token = bridge_token()?;
    let session_hash: String = Sha256::digest(session_token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let (stdout_log, stderr_log) =
        prepare_desktop_runtime_log(&log_path, port, &node_binary, &runtime_js)?;
    let mut command = Command::new(&node_binary);
    command
        .arg(runtime_js)
        .current_dir(app_dir)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("LUNERY_DESKTOP", "1")
        .env("LUNERY_DESKTOP_SESSION", session_token)
        .env("LUNERY_PARENT_PID", std::process::id().to_string())
        .env("LUNERY_HOME", &profile.root)
        .env("LUNERY_CONFIG_DIR", &profile.config)
        .env("LUNERY_DATA_DIR", &profile.data)
        .env("LUNERY_MODELS_DIR", &profile.models)
        .env("LUNERY_LOG_DIR", &profile.logs)
        .env("LUNERY_RUNTIME_DIR", &profile.runtime)
        .env(
            "LUNERY_DESKTOP_BRIDGE_URL",
            format!("http://127.0.0.1:{}", bridge.port),
        )
        .env("LUNERY_DESKTOP_BRIDGE_TOKEN", bridge.token)
        .env("ECOM_STORAGE_DIR", media_dir)
        .env("LUNERY_PUBLIC_DIR", public_dir)
        .env("LUNERY_PGLITE_DIR", pglite_dir)
        .env("LUNERY_PRISMA_MIGRATIONS_DIR", migrations_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log));
    for (key, value) in server_env {
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("Could not start desktop Studio server: {err}"))?;

    if let Err(err) = wait_for_port_or_child_exit(port, &mut child, &log_path, &session_hash) {
        let child_id = child.id();
        terminate_desktop_process(&mut child, Some(child_id));
        if let Some(ref lockfile) = pid_lockfile {
            let _ = std::fs::remove_file(lockfile);
        }
        return Err(err);
    }

    {
        let mut child_guard = state
            .child
            .lock()
            .map_err(|_| "Desktop server lock is poisoned".to_string())?;
        // Commit server state only after the port is reachable; otherwise a
        // failed first launch can make the next invocation return a stale URL.
        // New 2-line format ({pid}\n{abspath}\n) lets the next launch validate
        // before killing — see `kill_stale_pid_if_matches`.
        if let Some(ref lockfile) = pid_lockfile {
            write_pid_lockfile(lockfile, child.id(), &node_binary);
            let mut lockfile_guard = state
                .pid_lockfile
                .lock()
                .map_err(|_| "Desktop server pid-lockfile lock is poisoned".to_string())?;
            *lockfile_guard = Some(lockfile.clone());
        }
        #[cfg(unix)]
        {
            let mut group_guard = state
                .process_group
                .lock()
                .map_err(|_| "Desktop server process-group lock is poisoned".to_string())?;
            *group_guard = Some(child.id());
        }
        *child_guard = Some(child);
        let mut url_guard = state
            .url
            .lock()
            .map_err(|_| "Desktop server URL lock is poisoned".to_string())?;
        *url_guard = Some(url.clone());
    }

    Ok(DesktopServerStatus { url, port })
}

fn navigate_and_show(app: &AppHandle, target: &str) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main Studio window is missing".to_string())?;
    let url = tauri::Url::parse(target).map_err(|err| format!("Invalid Studio URL: {err}"))?;
    window
        .navigate(url)
        .map_err(|err| format!("Could not open Studio: {err}"))?;
    window
        .show()
        .map_err(|err| format!("Could not show Studio: {err}"))
}

fn show_startup_error(app: &AppHandle) {
    if let Err(err) = navigate_and_show(app, "tauri://localhost/error.html") {
        eprintln!("Could not show the desktop startup recovery page: {err}");
    }
}

fn boot_desktop_runtime(app: AppHandle, download_state: Arc<DownloadState>) {
    let state = app.state::<DesktopServerState>();
    if state.booting.swap(true, Ordering::SeqCst) {
        return;
    }

    #[cfg(debug_assertions)]
    let result = {
        let _ = &download_state;
        wait_for_port(3000).map(|_| DesktopServerStatus {
            url: "http://127.0.0.1:3000".to_string(),
            port: 3000,
        })
    };
    #[cfg(not(debug_assertions))]
    let result = start_desktop_server(&app, state.inner(), &download_state);

    state.booting.store(false, Ordering::SeqCst);
    match result {
        Ok(runtime) => {
            if let Err(err) = navigate_and_show(&app, &format!("{}/studio", runtime.url)) {
                eprintln!("Desktop Studio navigation failed: {err}");
                show_startup_error(&app);
            }
        }
        Err(err) => {
            eprintln!("Desktop Studio startup failed: {err}");
            show_startup_error(&app);
        }
    }
}

#[tauri::command]
fn retry_desktop_runtime(app: AppHandle, download_state: State<'_, Arc<DownloadState>>) {
    let download_state = Arc::clone(download_state.inner());
    thread::spawn(move || boot_desktop_runtime(app, download_state));
}

#[cfg(debug_assertions)]
fn write_desktop_dev_bridge_file(
    profile: &ProfileDirs,
    bridge: &DesktopBridge,
) -> Result<PathBuf, String> {
    ensure_profile_dirs(profile)?;
    let path = profile.runtime.join("desktop-dev-bridge.json");
    let payload = DesktopDevBridgeFile {
        url: format!("http://127.0.0.1:{}", bridge.port),
        token: bridge.token.clone(),
        pid: std::process::id(),
    };
    let json = serde_json::to_vec(&payload)
        .map_err(|err| format!("Could not serialize desktop dev bridge file: {err}"))?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|err| format!("Could not open desktop dev bridge file: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("Could not secure desktop dev bridge file: {err}"))?;
    }
    file.write_all(&json)
        .map_err(|err| format!("Could not write desktop dev bridge file: {err}"))?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// ModelResidency bridge commands — surface VRAM usage / budget to the UI so a
// Settings slider can tune the per-process budget at runtime. The actual
// caller integration (sd-cpp, llama-server, MLX) lands in a follow-up to keep
// this introduction focused on data plumbing.
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct ResidencyStatusPayload {
    pub current_usage_mb: u32,
    pub budget_mb_hint: u32,
}

/// QUARANTINED (dead-code-and-docs-cleanup-loop 2026-07-03): orphan command
/// wrapper. No JS/HTTP consumer (no `app/api/desktop-runtime/*` route, no
/// `invoke('residency_status')`, no Tauri event). Added in `acacfcc` for a
/// "future Settings VRAM panel" that was never built. The underlying
/// `ResidencyManager` / `residency_global()` IS live (engine wiring); only
/// these thin command wrappers are orphan. Gate-not-provable (deleting a
/// registered `#[tauri::command]` does not break `cargo build`), so
/// quarantined via annotation rather than direct-deleted. Decision next
/// release cycle: either ship the Settings VRAM panel or remove the trio.
#[tauri::command]
fn residency_status(state: State<'_, Arc<ResidencyManager>>) -> ResidencyStatusPayload {
    ResidencyStatusPayload {
        current_usage_mb: state.current_usage_mb(),
        // Surface the live budget so a Settings slider can render its
        // current position without a separate query — 0 still means
        // "unlimited" to the front end.
        budget_mb_hint: state.budget_mb(),
    }
}

/// QUARANTINED (dead-code-and-docs-cleanup-loop 2026-07-03): see
/// `residency_status` above — orphan command wrapper, no JS/HTTP consumer,
/// planned Settings VRAM panel never built. Remove next release cycle unless
/// the panel ships.
#[tauri::command]
fn residency_set_budget(state: State<'_, Arc<ResidencyManager>>, budget_mb: u32) {
    state.set_budget_mb(budget_mb);
}

/// Per-model snapshot for the Settings VRAM panel — id / kind label / cost
/// in MB / idle seconds / active-lease flag. The `kind` is stringified here
/// so the TS layer doesn't have to mirror the Rust enum.
#[derive(Clone, Serialize)]
pub struct ResidencyActiveModelPayload {
    pub id: String,
    pub kind: &'static str,
    pub vram_mb: u32,
    pub last_used_secs_ago: u64,
    pub is_active: bool,
}

/// QUARANTINED (dead-code-and-docs-cleanup-loop 2026-07-03): see
/// `residency_status` above — orphan command wrapper, no JS/HTTP consumer,
/// planned Settings VRAM panel never built. Remove next release cycle unless
/// the panel ships.
#[tauri::command]
fn residency_active_models(
    state: State<'_, Arc<ResidencyManager>>,
) -> Vec<ResidencyActiveModelPayload> {
    state
        .active_models()
        .into_iter()
        .map(|s| ResidencyActiveModelPayload {
            id: s.id,
            kind: kind_label(s.kind),
            vram_mb: s.vram_mb,
            last_used_secs_ago: s.last_used_secs_ago,
            is_active: s.is_active,
        })
        .collect()
}

fn kind_label(k: ModelKind) -> &'static str {
    match k {
        ModelKind::Llm => "llm",
        ModelKind::ImageDiffusion => "image-diffusion",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let download_state = Arc::new(DownloadState::default());
    let desktop_state = DesktopServerState::default();
    let watcher_cancel = Arc::clone(&desktop_state.watcher_cancel);
    let startup_download_state = Arc::clone(&download_state);
    #[cfg(debug_assertions)]
    let dev_bridge_download_state = Arc::clone(&download_state);
    // VRAM budget comes from `vram_probe`: total RAM / 3 * 2 on Apple
    // Silicon (unified memory), a conservative 8 GB on consumer NVIDIA /
    // Windows, 0 (unlimited) elsewhere. The user can override via the
    // Settings slider — `residency_set_budget` flips this at runtime.
    let detected = vram_probe::detect_budget_mb();
    let residency = Arc::new(ResidencyManager::new(detected));
    // Make the manager reachable from bridge threads (no Tauri State) via
    // a process-global. Ignore the unlikely race — both candidates point at
    // the same logical manager from the user's perspective.
    let _ = RESIDENCY_GLOBAL.set(Arc::clone(&residency));
    let builder = tauri::Builder::default()
        .manage(desktop_state)
        .manage(Arc::clone(&download_state))
        .manage(Arc::clone(&residency))
        .setup(move |app| {
            #[cfg(debug_assertions)]
            {
                let dev_bridge_result = profile_dirs().and_then(|profile| {
                    let bridge = start_desktop_bridge(Arc::clone(&dev_bridge_download_state))?;
                    write_desktop_dev_bridge_file(&profile, &bridge)
                });
                match dev_bridge_result {
                    Ok(path) => {
                        if let Ok(mut guard) =
                            app.state::<DesktopServerState>().dev_bridge_file.lock()
                        {
                            *guard = Some(path);
                        }
                    }
                    Err(err) => {
                        eprintln!("desktop dev bridge unavailable: {err}");
                    }
                }
            }
            // Local-runtime state watcher: emits "local-runtime-changed" when
            // llama/mlx running flags or MLX phase change, so the frontend can
            // refresh status without polling /api/desktop-runtime/status on a
            // 30s schedule. Polling remains in place as a fallback (visibility
            // change + 30s).
            //
            // Cancellation: DesktopServerState::shutdown flips watcher_cancel;
            // the loop checks each tick so app shutdown doesn't leak this thread.
            let app_handle = app.handle().clone();
            let cancel = Arc::clone(&watcher_cancel);
            thread::spawn(move || {
                let mut last_llama_running = false;
                let mut last_mlx_running = false;
                let mut last_mlx_phase = String::new();
                loop {
                    thread::sleep(Duration::from_secs(2));
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let llama_running = llama_engine_slot()
                        .lock()
                        .ok()
                        .map(|g| g.is_some())
                        .unwrap_or(false);
                    let mlx_slot = mlx_engine_slot().lock().ok().and_then(|g| g.clone());
                    let mlx_job = mlx_job_slot().lock().ok().and_then(|g| g.clone());
                    let mlx_running = mlx_slot.is_some();
                    let mlx_phase = mlx_job
                        .as_ref()
                        .map(|j| j.phase.clone())
                        .unwrap_or_default();

                    if llama_running != last_llama_running
                        || mlx_running != last_mlx_running
                        || mlx_phase != last_mlx_phase
                    {
                        last_llama_running = llama_running;
                        last_mlx_running = mlx_running;
                        // Clone for the emit JSON; the cached `last_mlx_phase`
                        // takes ownership of the original so subsequent ticks
                        // can dedup without re-reading the slot.
                        last_mlx_phase = mlx_phase.clone();
                        let _ = app_handle.emit(
                            "local-runtime-changed",
                            serde_json::json!({
                                "llamaRunning": llama_running,
                                "mlxRunning": mlx_running,
                                "mlxPhase": mlx_phase,
                            }),
                        );
                    }
                }
            });
            let startup_app = app.handle().clone();
            let startup_download_state = Arc::clone(&startup_download_state);
            thread::spawn(move || boot_desktop_runtime(startup_app, startup_download_state));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_runtime_status,
            save_provider_secret,
            delete_provider_secret,
            retry_desktop_runtime,
            detect_hardware,
            probe_local_runtime,
            hf_download_start,
            hf_download_cancel,
            hf_download_status,
            hf_download_list,
            residency_status,
            residency_set_budget,
            residency_active_models,
        ]);

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(err) => {
            eprintln!("failed to build Lunery Lab desktop app: {err}");
            return;
        }
    };

    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            app.state::<DesktopServerState>().shutdown();
            bridge_stop_llama();
            bridge_stop_sd();
            bridge_stop_mlx();
        }
    });
}

#[cfg(all(test, unix))]
mod desktop_server_lifecycle_tests {
    use crate::{pid_matches_expected_binary, DesktopServerState};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::atomic::Ordering;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn shutdown_reaps_runtime_child_and_cleans_runtime_files() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("lunery-desktop-shutdown-{nanos}"));
        std::fs::create_dir_all(&root).expect("create lifecycle test directory");
        let pid_lockfile = root.join("desktop-server.pid");
        let dev_bridge_file = root.join("desktop-dev-bridge.json");
        std::fs::write(&pid_lockfile, b"test").expect("create pid lockfile");
        std::fs::write(&dev_bridge_file, b"test").expect("create dev bridge file");

        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 30 & wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.process_group(0);
        let child = command.spawn().expect("spawn lifecycle test child");
        let child_pid = child.id();
        let process_group = format!("-{child_pid}");

        let state = DesktopServerState::default();
        *state.child.lock().expect("lock child state") = Some(child);
        *state.process_group.lock().expect("lock process group") = Some(child_pid);
        *state.url.lock().expect("lock URL state") = Some("http://127.0.0.1:1".to_string());
        *state.pid_lockfile.lock().expect("lock pid file state") = Some(pid_lockfile.clone());
        *state
            .dev_bridge_file
            .lock()
            .expect("lock bridge file state") = Some(dev_bridge_file.clone());

        assert!(pid_matches_expected_binary(child_pid, "/bin/sh"));
        assert!(Command::new("kill")
            .args(["-0", &process_group])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("probe process group")
            .success());

        state.shutdown();

        assert!(state.watcher_cancel.load(Ordering::Relaxed));
        assert!(state.child.lock().expect("lock child state").is_none());
        assert!(state.url.lock().expect("lock URL state").is_none());
        assert!(!pid_lockfile.exists());
        assert!(!dev_bridge_file.exists());
        assert!(!pid_matches_expected_binary(child_pid, "/bin/sh"));
        assert!(!Command::new("kill")
            .args(["-0", &process_group])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("probe reaped process group")
            .success());

        state.shutdown();
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod engine_epoch_tests {
    use crate::{current_engine_epoch, next_engine_epoch, test_global_lock};

    #[test]
    fn epoch_is_strictly_monotonic() {
        let _g = test_global_lock();
        let a = next_engine_epoch();
        let b = next_engine_epoch();
        assert!(b > a, "each bump must strictly increase the epoch");
        assert_eq!(current_engine_epoch(), b, "current reflects the last bump");
    }
}

#[cfg(test)]
mod log_rotation_tests {
    use super::rotate_log_if_needed;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lunerylab-log-{name}-{nonce}"));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    #[test]
    fn does_not_rotate_below_cap() {
        let dir = temp_dir("small");
        let log = dir.join("desktop-runtime.log");
        std::fs::write(&log, b"small").unwrap();
        rotate_log_if_needed(&log, 1024, 2);
        assert!(log.exists(), "log under cap stays in place");
        assert!(!log.with_extension("log.1").exists(), "no backup created");
    }

    #[test]
    fn rotates_and_shifts_backups_when_over_cap() {
        let dir = temp_dir("rotate");
        let log = dir.join("desktop-runtime.log");
        // Pre-existing .1 backup should shift to .2 on rotation.
        std::fs::write(log.with_extension("log.1"), b"older").unwrap();
        let mut f = std::fs::File::create(&log).unwrap();
        f.write_all(&vec![b'x'; 2048]).unwrap();

        rotate_log_if_needed(&log, 1024, 2);

        assert!(!log.exists(), "current log rotated away");
        assert_eq!(
            std::fs::read(log.with_extension("log.1")).unwrap().len(),
            2048
        );
        assert_eq!(
            std::fs::read(log.with_extension("log.2")).unwrap(),
            b"older"
        );
    }
}

#[cfg(test)]
mod bridge_security_tests {
    use crate::download::{models_root_path, validate_hf_download_dest, validate_hf_download_url};
    use crate::hardware::loopback_socket_addr;
    use crate::profile::ProfileDirs;
    use crate::{
        command_line_matches_expected_binary, test_global_lock, write_desktop_dev_bridge_file,
        DesktopBridge,
    };
    use std::ffi::OsString;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct EnvRestore {
        values: Vec<(&'static str, Option<OsString>)>,
    }

    impl EnvRestore {
        fn capture(names: &[&'static str]) -> Self {
            Self {
                values: names
                    .iter()
                    .map(|name| (*name, std::env::var_os(name)))
                    .collect(),
            }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            for (name, value) in &self.values {
                if let Some(value) = value {
                    std::env::set_var(name, value);
                } else {
                    std::env::remove_var(name);
                }
            }
        }
    }

    fn unique_test_profile(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("lunery-{name}-{nanos}"))
    }

    fn test_profile_dirs(root: PathBuf) -> ProfileDirs {
        let data = root.join("data");
        ProfileDirs {
            config: root.join("config"),
            pglite: data.join("pglite"),
            media: data.join("media"),
            models: root.join("models"),
            logs: root.join("logs"),
            runtime: root.join("runtime"),
            root,
            data,
        }
    }

    #[test]
    fn command_line_match_preserves_executable_paths_with_spaces() {
        let executable =
            "/Applications/Lunery Lab Studio.app/Contents/Resources/engine/llama-server";
        assert!(command_line_matches_expected_binary(executable, executable));
        assert!(command_line_matches_expected_binary(
            &format!("{executable} --model /tmp/model.gguf"),
            executable,
        ));
        assert!(!command_line_matches_expected_binary(
            &format!("{executable}-other --model /tmp/model.gguf"),
            executable,
        ));
        assert!(!command_line_matches_expected_binary(executable, ""));
    }

    #[cfg(unix)]
    #[test]
    fn desktop_dev_bridge_file_is_owner_only_even_when_reused() {
        use std::os::unix::fs::PermissionsExt;

        let profile = test_profile_dirs(unique_test_profile("dev-bridge-permissions"));
        std::fs::create_dir_all(&profile.runtime).expect("create runtime dir");
        let path = profile.runtime.join("desktop-dev-bridge.json");
        std::fs::write(&path, b"old").expect("seed existing bridge file");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("make existing file permissive");

        let written = write_desktop_dev_bridge_file(
            &profile,
            &DesktopBridge {
                port: 43123,
                token: "test-token".to_string(),
            },
        )
        .expect("write bridge file");

        assert_eq!(written, path);
        assert_eq!(
            std::fs::metadata(&written)
                .expect("read bridge file metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600,
        );
        let _ = std::fs::remove_dir_all(&profile.root);
    }

    #[test]
    fn hf_download_url_rejects_non_huggingface_hosts() {
        assert!(validate_hf_download_url(
            "https://huggingface.co/org/repo/resolve/main/model.gguf"
        )
        .is_ok());
        assert!(validate_hf_download_url("https://attacker.example/status").is_err());
        assert!(
            validate_hf_download_url("http://huggingface.co/org/repo/resolve/main/model.gguf")
                .is_err()
        );
        assert!(
            validate_hf_download_url("https://huggingface.co/org/repo/blob/main/model.gguf")
                .is_err()
        );
        assert!(validate_hf_download_url("https://huggingface.co/org/repo/tree/main").is_err());
        assert!(
            validate_hf_download_url("https://huggingface.co/org/repo/resolve/main/model.txt")
                .is_err()
        );
    }

    #[test]
    fn hf_download_dest_rejects_outside_model_cache() {
        let _guard = test_global_lock();
        let _env = EnvRestore::capture(&["LUNERY_HOME", "LUNERY_MODELS_DIR"]);
        std::env::set_var("LUNERY_HOME", unique_test_profile("hf-dest"));
        std::env::remove_var("LUNERY_MODELS_DIR");

        assert!(validate_hf_download_dest("/tmp/model.gguf").is_err());
        assert!(validate_hf_download_dest("../model.gguf").is_err());
        let root = models_root_path().expect("models root");
        let valid = root.join("llama-cpp").join("model.gguf");
        assert!(validate_hf_download_dest(&valid.to_string_lossy()).is_ok());
        let invalid_runtime = root.join("unknown-runtime").join("model.gguf");
        assert!(validate_hf_download_dest(&invalid_runtime.to_string_lossy()).is_err());
    }

    #[test]
    fn runtime_probe_accepts_only_loopback_endpoint() {
        assert!(loopback_socket_addr("http://127.0.0.1:11434").is_some());
        assert!(loopback_socket_addr("http://localhost:11434/v1").is_some());
        assert!(loopback_socket_addr("http://192.168.1.5:11434").is_none());
    }
}
