mod download;
mod engine_lifecycle;
mod engine_llama;
mod engine_mlx;
mod engine_paths;
mod engine_sd;
mod external_apps;
mod hardware;
mod http_bridge;
mod llama_resident;
mod mlx_resident;
mod model_residency;
mod profile;
mod profile_fs;
mod sd_cpp_resident;
mod secrets;
mod security;
mod vram_probe;

use crate::download::DownloadState;
use crate::engine_llama::{bridge_stop_llama, llama_engine_slot};
use crate::engine_mlx::{bridge_stop_mlx, mlx_engine_slot, mlx_job_slot, mlx_progress_slot};
use crate::engine_sd::{bridge_stop_sd, sd_binary_path};
use crate::external_apps::{is_lmstudio_installed, is_ollama_installed};
use crate::hardware::{cached_accel, detect_hardware, probe_local_runtime, AccelInfo};
use crate::http_bridge::{start_desktop_bridge, DesktopBridgeServer, WorkspaceResetHandler};
use crate::profile::{
    acquire_profile_advisory_lock, ensure_profile_dirs, profile_dirs, ProfileAdvisoryLock,
    ProfileDirs, ProfileStorageDirs,
};
#[cfg(not(debug_assertions))]
use crate::profile_fs::refresh_profile_fs_roots;
use crate::profile_fs::{clear_stale_workspace_initialization_lock, initialize_profile_fs_roots};
use crate::secrets::{delete_provider_secret, keychain_secret_state, save_provider_secret};
#[cfg(not(debug_assertions))]
use crate::security::bridge_token;

use model_residency::ResidencyManager;
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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
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

pub(crate) fn get_http_client_with_connect_timeout(
    connect_timeout: Duration,
) -> Result<reqwest::Client, reqwest::Error> {
    // Shared client uses the production connect bound. Tests that inject a
    // shorter connect timeout build an ephemeral client instead.
    if connect_timeout == Duration::from_secs(30) {
        if let Some(c) = HTTP_CLIENT.get() {
            return Ok(c.clone());
        }
        let candidate = reqwest::Client::builder()
            .user_agent("Lunery Lab Desktop/1.0")
            .connect_timeout(connect_timeout)
            .build()?;
        let _ = HTTP_CLIENT.set(candidate);
        return Ok(HTTP_CLIENT.get().expect("OnceLock set above").clone());
    }
    reqwest::Client::builder()
        .user_agent("Lunery Lab Desktop/1.0")
        .connect_timeout(connect_timeout)
        .build()
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
    bridge_server: Mutex<Option<DesktopBridgeServer>>,
    pid_lockfile: Mutex<Option<PathBuf>>,
    dev_bridge_file: Mutex<Option<PathBuf>>,
    dev_bridge_server: Mutex<Option<DesktopBridgeServer>>,
    /// OS advisory lock for the resolved profile. Held for the app lifetime;
    /// the lock file itself is persistent and must not be unlinked on unlock.
    profile_lock: Mutex<Option<ProfileAdvisoryLock>>,
    runtime_operation: AtomicU8,
    /// Serialises lifecycle revocation against the final child/bridge/PID/URL
    /// commit. Shutdown can therefore never lose a race to a late boot commit.
    lifecycle_commit: Mutex<()>,
    lifecycle_epoch: AtomicU64,
    lifecycle_cancelled: AtomicBool,
    lifecycle_wake: Condvar,
    lifecycle_wait: Mutex<()>,
    lifecycle_tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl DesktopServerState {
    fn begin_lifecycle_epoch(&self) -> Result<u64, String> {
        let _commit = self
            .lifecycle_commit
            .lock()
            .map_err(|_| "Desktop lifecycle lock is poisoned".to_string())?;
        if self.lifecycle_cancelled.load(Ordering::Acquire) {
            return Err("Desktop runtime is shutting down".to_string());
        }
        Ok(self.lifecycle_epoch.fetch_add(1, Ordering::AcqRel) + 1)
    }

    fn lifecycle_is_current(&self, epoch: u64) -> bool {
        !self.lifecycle_cancelled.load(Ordering::Acquire)
            && self.lifecycle_epoch.load(Ordering::Acquire) == epoch
    }

    fn lifecycle_is_cancelled(&self) -> bool {
        self.lifecycle_cancelled.load(Ordering::Acquire)
    }

    /// Returns true when cancellation was observed, including a poisoned wait
    /// lock (fail closed during teardown).
    fn wait_for_lifecycle_cancel(&self, duration: Duration) -> bool {
        if self.lifecycle_is_cancelled() {
            return true;
        }
        let guard = match self.lifecycle_wait.lock() {
            Ok(guard) => guard,
            Err(_) => return true,
        };
        let _ = self
            .lifecycle_wake
            .wait_timeout_while(guard, duration, |_| !self.lifecycle_is_cancelled());
        self.lifecycle_is_cancelled()
    }

    fn spawn_lifecycle_task(
        &self,
        name: &str,
        work: impl FnOnce() + Send + 'static,
    ) -> Result<(), String> {
        let mut tasks = self
            .lifecycle_tasks
            .lock()
            .map_err(|_| "Desktop lifecycle task registry is poisoned".to_string())?;
        if self.lifecycle_is_cancelled() {
            return Err("Desktop runtime is shutting down".to_string());
        }
        let mut active = Vec::with_capacity(tasks.len() + 1);
        for task in tasks.drain(..) {
            if task.is_finished() {
                let _ = task.join();
            } else {
                active.push(task);
            }
        }
        let task = thread::Builder::new()
            .name(name.to_string())
            .spawn(work)
            .map_err(|error| format!("Could not start {name}: {error}"))?;
        active.push(task);
        *tasks = active;
        Ok(())
    }

    fn revoke_lifecycle(&self) {
        let _commit = self
            .lifecycle_commit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.lifecycle_cancelled.store(true, Ordering::Release);
        self.lifecycle_epoch.fetch_add(1, Ordering::AcqRel);
        self.lifecycle_wake.notify_all();
    }

    fn join_lifecycle_tasks(&self) {
        let tasks = {
            let mut tasks = self
                .lifecycle_tasks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            std::mem::take(&mut *tasks)
        };
        for task in tasks {
            let _ = task.join();
        }
    }

    fn stop_runtime(&self) {
        // Bridge shutdown revokes admission first, then interrupts long work /
        // advances the SD epoch, then drains accepted workers. Stop the other
        // embedded engines around the same boundary so queued work cannot spawn
        // after teardown.
        let bridge_server = self
            .bridge_server
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(bridge_server) = bridge_server {
            bridge_server.shutdown();
        }
        bridge_stop_llama();
        bridge_stop_mlx();
        bridge_stop_sd();

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

        #[cfg(unix)]
        {
            let mut process_group_guard = self
                .process_group
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *process_group_guard = None;
        }

        let mut pid_lockfile_guard = self
            .pid_lockfile
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(path) = pid_lockfile_guard.take() {
            let _ = std::fs::remove_file(path);
        }
        drop(pid_lockfile_guard);

        let mut url_guard = self
            .url
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *url_guard = None;
    }

    fn shutdown(&self) {
        let had_started = self.lifecycle_epoch.load(Ordering::Acquire) > 0;
        self.revoke_lifecycle();
        if had_started {
            crate::secrets::shutdown_secret_runtime();
        }
        self.stop_runtime();

        let mut dev_bridge_guard = self
            .dev_bridge_file
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(path) = dev_bridge_guard.take() {
            let _ = std::fs::remove_file(path);
        }
        drop(dev_bridge_guard);

        let dev_bridge_server = self
            .dev_bridge_server
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(dev_bridge_server) = dev_bridge_server {
            dev_bridge_server.shutdown();
        }
        self.join_lifecycle_tasks();
    }
}

fn acquire_profile_lock_for_startup(
    state: &DesktopServerState,
    profile: &ProfileDirs,
) -> Result<(), String> {
    let profile_lock = acquire_profile_advisory_lock(profile)?;
    let mut guard = state
        .profile_lock
        .lock()
        .map_err(|_| "Desktop profile lock holder is poisoned".to_string())?;
    *guard = Some(profile_lock);
    Ok(())
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
    keychain_status: &'static str,
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

pub(crate) const DESKTOP_WORKSPACE_RESET_CONFIRMATION: &str = "DELETE_LUNERY_WORKSPACE";
const RUNTIME_OPERATION_IDLE: u8 = 0;
const RUNTIME_OPERATION_BOOT: u8 = 1;
#[cfg(not(debug_assertions))]
const RUNTIME_OPERATION_RESET: u8 = 2;

#[cfg(all(unix, any(test, not(debug_assertions))))]
fn profile_directory_identity(file: &std::fs::File) -> Result<(u64, u64), String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect pinned profile directory: {error}"))?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(all(unix, any(test, not(debug_assertions))))]
fn verify_profile_root_identity(root_path: &Path, expected: (u64, u64)) -> Result<(), String> {
    use rustix::fs::{open, Mode, OFlags};
    let current = std::fs::File::from(
        open(
            root_path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|error| format!("Profile root changed during reset: {error}"))?,
    );
    if profile_directory_identity(&current)? != expected {
        return Err("Profile root changed during reset".to_string());
    }
    Ok(())
}

#[cfg(all(unix, any(test, not(debug_assertions))))]
fn remove_directory_contents_at(directory: &std::fs::File) -> Result<(), String> {
    use rustix::fs::{openat, unlinkat, AtFlags, Mode, OFlags};
    #[cfg(target_os = "linux")]
    use std::os::fd::AsRawFd;
    #[cfg(target_vendor = "apple")]
    use std::os::unix::ffi::OsStrExt;

    #[cfg(target_os = "linux")]
    let directory_path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
    #[cfg(target_vendor = "apple")]
    let directory_path = PathBuf::from(std::ffi::OsStr::from_bytes(
        rustix::fs::getpath(directory)
            .map_err(|error| format!("Could not resolve pinned profile data: {error}"))?
            .to_bytes(),
    ));
    #[cfg(not(any(target_os = "linux", target_vendor = "apple")))]
    let directory_path: PathBuf =
        return Err("Workspace reset is unavailable on this Unix platform".to_string());
    let names = std::fs::read_dir(&directory_path)
        .map_err(|error| format!("Could not enumerate profile data: {error}"))?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|error| format!("Could not enumerate profile data: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    for name in names {
        match openat(
            directory,
            &name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        ) {
            Ok(child) => {
                let child = std::fs::File::from(child);
                remove_directory_contents_at(&child)?;
                unlinkat(directory, &name, AtFlags::REMOVEDIR).map_err(|error| {
                    format!("Could not remove profile directory entry: {error}")
                })?;
            }
            Err(rustix::io::Errno::NOENT) => {}
            Err(rustix::io::Errno::NOTDIR | rustix::io::Errno::LOOP) => {
                unlinkat(directory, &name, AtFlags::empty())
                    .map_err(|error| format!("Could not remove profile file entry: {error}"))?;
            }
            Err(error) => {
                return Err(format!("Could not inspect profile data entry: {error}"));
            }
        }
    }
    Ok(())
}

#[cfg(all(unix, any(test, not(debug_assertions))))]
fn reset_workspace_data_unix<F>(dirs: &ProfileDirs, after_pin: F) -> Result<(), String>
where
    F: FnOnce(),
{
    use rustix::fs::{mkdirat, open, openat, unlinkat, AtFlags, Mode, OFlags};

    let canonical_root = dirs.root.canonicalize().map_err(|error| {
        format!(
            "Could not verify profile root {}: {error}",
            dirs.root.display()
        )
    })?;
    let root = std::fs::File::from(
        open(
            &canonical_root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|error| format!("Could not pin profile root: {error}"))?,
    );
    let root_identity = profile_directory_identity(&root)?;
    after_pin();
    verify_profile_root_identity(&dirs.root, root_identity)?;

    match openat(
        &root,
        "data",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    ) {
        Ok(data) => {
            let data = std::fs::File::from(data);
            remove_directory_contents_at(&data)?;
            unlinkat(&root, "data", AtFlags::REMOVEDIR)
                .map_err(|error| format!("Could not remove profile data directory: {error}"))?;
        }
        Err(rustix::io::Errno::NOENT) => {}
        Err(rustix::io::Errno::NOTDIR | rustix::io::Errno::LOOP) => {
            unlinkat(&root, "data", AtFlags::empty())
                .map_err(|error| format!("Could not remove profile data entry: {error}"))?;
        }
        Err(error) => return Err(format!("Could not inspect profile data directory: {error}")),
    }
    verify_profile_root_identity(&dirs.root, root_identity)?;
    mkdirat(&root, "data", Mode::from_raw_mode(0o700))
        .map_err(|error| format!("Could not recreate profile data directory: {error}"))?;
    let data = std::fs::File::from(
        openat(
            &root,
            "data",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|error| format!("Could not pin recreated profile data: {error}"))?,
    );
    for child in ["pglite", "media"] {
        mkdirat(&data, child, Mode::from_raw_mode(0o700))
            .map_err(|error| format!("Could not recreate profile {child} directory: {error}"))?;
    }
    verify_profile_root_identity(&dirs.root, root_identity)
}

#[cfg(any(test, not(debug_assertions)))]
fn reset_workspace_data(dirs: &ProfileDirs) -> Result<(), String> {
    use std::path::Component;

    let expected_data = dirs.root.join("data");
    if !dirs.root.is_absolute()
        || dirs
            .root
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        || dirs.data != expected_data
        || dirs.pglite != expected_data.join("pglite")
        || dirs.media != expected_data.join("media")
    {
        return Err(
            "Workspace reset only deletes the resolved Lunery profile data directory".to_string(),
        );
    }

    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let normal_component_count = dirs
        .root
        .components()
        .filter(|component| matches!(component, Component::Normal(_)))
        .count();
    if dirs.root.parent().is_none()
        || dirs.root.parent() == Some(Path::new("/"))
        || home
            .as_ref()
            .is_some_and(|home| dirs.root == *home || dirs.root.parent() == Some(home.as_path()))
        || normal_component_count < 2
    {
        return Err("Refusing to reset an unsafe or overly broad profile path".to_string());
    }

    for candidate in [dirs.root.parent(), Some(dirs.root.as_path())]
        .into_iter()
        .flatten()
    {
        if std::fs::symlink_metadata(candidate)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("Refusing to reset a profile reached through a symlink".to_string());
        }
    }

    #[cfg(unix)]
    {
        reset_workspace_data_unix(dirs, || {})
    }
    #[cfg(not(unix))]
    {
        Err(
            "Workspace reset is unavailable until reparse-safe directory operations are enabled"
                .to_string(),
        )
    }
}

#[tauri::command]
fn open_desktop_profile_folder() -> Result<(), String> {
    let folder = profile_dirs()?.root;
    std::fs::create_dir_all(&folder)
        .map_err(|err| format!("Could not create {}: {err}", folder.display()))?;

    let mut command = if cfg!(target_os = "macos") {
        Command::new("open")
    } else if cfg!(windows) {
        Command::new("explorer")
    } else {
        Command::new("xdg-open")
    };
    command
        .arg(&folder)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Could not open the Lunery profile folder: {err}"))
}

fn has_env_key(keys: &[&str]) -> bool {
    keys.iter().any(|key| std::env::var_os(key).is_some())
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
    state: &DesktopServerState,
    epoch: u64,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut backoff = Duration::from_millis(200);
    let mut last_health_error = "Studio health check has not responded".to_string();
    while Instant::now() < deadline {
        if !state.lifecycle_is_current(epoch) {
            return Err("Desktop runtime start was superseded".to_string());
        }
        match probe_desktop_health(port, expected_session_hash) {
            Ok(()) if state.lifecycle_is_current(epoch) => return Ok(()),
            Ok(()) => return Err("Desktop runtime start was superseded".to_string()),
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
        let sleep_deadline = Instant::now() + backoff;
        while Instant::now() < sleep_deadline {
            if !state.lifecycle_is_current(epoch) {
                return Err("Desktop runtime start was superseded".to_string());
            }
            thread::sleep(
                Duration::from_millis(50)
                    .min(sleep_deadline.saturating_duration_since(Instant::now())),
            );
        }
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

fn wait_for_port_while(port: u16, mut is_current: impl FnMut() -> bool) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut backoff = Duration::from_millis(200);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    while Instant::now() < deadline {
        if !is_current() {
            return Err("Desktop runtime start was superseded".to_string());
        }
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return if is_current() {
                Ok(())
            } else {
                Err("Desktop runtime start was superseded".to_string())
            };
        }
        let sleep_deadline = Instant::now() + backoff;
        while Instant::now() < sleep_deadline {
            if !is_current() {
                return Err("Desktop runtime start was superseded".to_string());
            }
            thread::sleep(
                Duration::from_millis(50)
                    .min(sleep_deadline.saturating_duration_since(Instant::now())),
            );
        }
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
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|err| format!("Could not resolve bundled resource directory: {err}"))?;
    bundled_desktop_server_root(&resource_dir)
}

#[cfg(any(test, not(debug_assertions)))]
fn bundled_desktop_server_root(resource_dir: &Path) -> Result<PathBuf, String> {
    for bundled in [
        resource_dir.join("desktop-server"),
        resource_dir.join("_up_").join("desktop-server"),
    ] {
        if bundled.is_dir() {
            return Ok(bundled);
        }
    }

    Err(
        "Bundled desktop server resources were not found in the Tauri resource directory"
            .to_string(),
    )
}

#[cfg(not(debug_assertions))]
const DESKTOP_SERVER_ENV_KEYS: &[&str] = &["LUNERY_MAX_UPLOAD_BYTES_PER_FILE"];

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
    let keychain_status = keychain_secret_state(id);
    ProviderConnectionStatus {
        id,
        label,
        auth: "API key",
        configured: env_configured || keychain_status.is_present(),
        source: if env_configured {
            "environment"
        } else if keychain_status.is_present() {
            "system-keychain"
        } else {
            "none"
        },
        secret_store: "system-keychain",
        keychain_status: keychain_status.as_str(),
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
            provider_status("xai", "xAI", &["XAI_API_KEY"]),
            provider_status("mistral", "Mistral AI", &["MISTRAL_API_KEY"]),
            provider_status("deepseek", "DeepSeek", &["DEEPSEEK_API_KEY"]),
            provider_status("groq", "Groq", &["GROQ_API_KEY"]),
            provider_status("perplexity", "Perplexity", &["PERPLEXITY_API_KEY"]),
            provider_status("cerebras", "Cerebras", &["CEREBRAS_API_KEY"]),
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
    epoch: u64,
) -> Result<DesktopServerStatus, String> {
    if !state.lifecycle_is_current(epoch) {
        return Err("Desktop runtime start was superseded".to_string());
    }
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
                return if state.lifecycle_is_current(epoch) {
                    Ok(DesktopServerStatus { url, port })
                } else {
                    Err("Desktop runtime start was superseded".to_string())
                };
            }
            *child_guard = None;
        }
    }

    if !state.lifecycle_is_current(epoch) {
        return Err("Desktop runtime start was superseded".to_string());
    }
    let profile = profile_dirs()?;
    ensure_profile_dirs(&profile)?;
    // A backend crash can leave the cross-bundle first-boot lock behind while
    // the Tauri shell remains alive. We only reach this point after proving
    // there is no live desktop child, so its lock cannot have a current owner.
    clear_stale_workspace_initialization_lock()?;

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
        if !state.lifecycle_is_current(epoch) {
            return Err("Desktop runtime start was superseded".to_string());
        }
        kill_stale_pid_if_matches(lockfile, &node_bin_abspath);
    }

    let port = reserve_local_port()?;
    let url = format!("http://127.0.0.1:{port}");
    if !state.lifecycle_is_current(epoch) {
        return Err("Desktop runtime start was superseded".to_string());
    }
    let bridge_server = start_desktop_bridge(
        Arc::clone(download_state),
        workspace_reset_handler(app.clone(), Arc::clone(download_state)),
    )?;
    if !state.lifecycle_is_current(epoch) {
        bridge_server.shutdown();
        return Err("Desktop runtime start was superseded".to_string());
    }
    let bridge_port = bridge_server.bridge.port;
    let bridge_auth_token = bridge_server.bridge.token.clone();
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
            format!("http://127.0.0.1:{bridge_port}"),
        )
        .env("LUNERY_DESKTOP_BRIDGE_TOKEN", bridge_auth_token)
        .env("LUNERY_MEDIA_DIR", media_dir)
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
    if !state.lifecycle_is_current(epoch) {
        bridge_server.shutdown();
        return Err("Desktop runtime start was superseded".to_string());
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("Could not start desktop Studio server: {err}"))?;

    if let Err(err) =
        wait_for_port_or_child_exit(port, &mut child, &log_path, &session_hash, state, epoch)
    {
        let child_id = child.id();
        terminate_desktop_process(&mut child, Some(child_id));
        if let Some(ref lockfile) = pid_lockfile {
            let _ = std::fs::remove_file(lockfile);
        }
        return Err(err);
    }

    {
        let _commit = state
            .lifecycle_commit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state.lifecycle_is_current(epoch) {
            let child_id = child.id();
            terminate_desktop_process(&mut child, Some(child_id));
            if let Some(ref lockfile) = pid_lockfile {
                let _ = std::fs::remove_file(lockfile);
            }
            bridge_server.shutdown();
            return Err("Desktop runtime start was superseded".to_string());
        }
        let mut child_guard = state
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Commit server state only after the port is reachable; otherwise a
        // failed first launch can make the next invocation return a stale URL.
        // New 2-line format ({pid}\n{abspath}\n) lets the next launch validate
        // before killing — see `kill_stale_pid_if_matches`.
        if let Some(ref lockfile) = pid_lockfile {
            write_pid_lockfile(lockfile, child.id(), &node_binary);
            let mut lockfile_guard = state
                .pid_lockfile
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *lockfile_guard = Some(lockfile.clone());
        }
        #[cfg(unix)]
        {
            let mut group_guard = state
                .process_group
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *group_guard = Some(child.id());
        }
        *child_guard = Some(child);
        let mut bridge_guard = state
            .bridge_server
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *bridge_guard = Some(bridge_server);
        let mut url_guard = state
            .url
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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

fn boot_desktop_runtime_inner(app: &AppHandle, download_state: &Arc<DownloadState>, epoch: u64) {
    let state = app.state::<DesktopServerState>();
    if !state.lifecycle_is_current(epoch) {
        return;
    }

    #[cfg(debug_assertions)]
    let result = {
        let _ = &download_state;
        wait_for_port_while(3000, || state.lifecycle_is_current(epoch)).map(|_| {
            DesktopServerStatus {
                url: "http://127.0.0.1:3000".to_string(),
                port: 3000,
            }
        })
    };
    #[cfg(not(debug_assertions))]
    let result = start_desktop_server(app, state.inner(), download_state, epoch);

    if !state.lifecycle_is_current(epoch) {
        return;
    }

    match result {
        Ok(runtime) => {
            if !state.lifecycle_is_current(epoch) {
                return;
            }
            if let Err(err) = navigate_and_show(app, &format!("{}/studio", runtime.url)) {
                eprintln!("Desktop Studio navigation failed: {err}");
                if state.lifecycle_is_current(epoch) {
                    show_startup_error(app);
                }
            }
        }
        Err(err) => {
            eprintln!("Desktop Studio startup failed: {err}");
            if state.lifecycle_is_current(epoch) {
                show_startup_error(app);
            }
        }
    }
}

fn schedule_desktop_runtime_boot(
    app: AppHandle,
    download_state: Arc<DownloadState>,
) -> Result<(), String> {
    let state = app.state::<DesktopServerState>();
    if state
        .runtime_operation
        .compare_exchange(
            RUNTIME_OPERATION_IDLE,
            RUNTIME_OPERATION_BOOT,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_err()
    {
        return Ok(());
    }
    let epoch = match state.begin_lifecycle_epoch() {
        Ok(epoch) => epoch,
        Err(error) => {
            state
                .runtime_operation
                .store(RUNTIME_OPERATION_IDLE, Ordering::SeqCst);
            return Err(error);
        }
    };
    let task_app = app.clone();
    let result = state.spawn_lifecycle_task("lunery-desktop-boot", move || {
        boot_desktop_runtime_inner(&task_app, &download_state, epoch);
        let state = task_app.state::<DesktopServerState>();
        if state.lifecycle_is_current(epoch) {
            state
                .runtime_operation
                .store(RUNTIME_OPERATION_IDLE, Ordering::SeqCst);
        }
    });
    if result.is_err() {
        state
            .runtime_operation
            .store(RUNTIME_OPERATION_IDLE, Ordering::SeqCst);
    }
    result
}

fn workspace_reset_handler(
    app: AppHandle,
    download_state: Arc<DownloadState>,
) -> WorkspaceResetHandler {
    Arc::new(move || {
        request_desktop_workspace_reset(
            app.clone(),
            Arc::clone(&download_state),
            DESKTOP_WORKSPACE_RESET_CONFIRMATION,
        )
    })
}

fn request_desktop_workspace_reset(
    app: AppHandle,
    download_state: Arc<DownloadState>,
    confirmation: &str,
) -> Result<(), String> {
    if confirmation != DESKTOP_WORKSPACE_RESET_CONFIRMATION {
        return Err("Explicit workspace reset confirmation is required".to_string());
    }

    #[cfg(debug_assertions)]
    {
        let _ = (app, download_state);
        Err(
            "Workspace reset is available in packaged Studio builds; development runtime data must be reset by its owner"
                .to_string(),
        )
    }

    #[cfg(not(debug_assertions))]
    {
        let state = app.state::<DesktopServerState>();
        if state
            .runtime_operation
            .compare_exchange(
                RUNTIME_OPERATION_IDLE,
                RUNTIME_OPERATION_RESET,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_err()
        {
            return Err("Studio is already starting or resetting".to_string());
        }

        let epoch = match state.begin_lifecycle_epoch() {
            Ok(epoch) => epoch,
            Err(error) => {
                state
                    .runtime_operation
                    .store(RUNTIME_OPERATION_IDLE, Ordering::SeqCst);
                return Err(error);
            }
        };
        let task_app = app.clone();
        if let Err(error) = state.spawn_lifecycle_task("lunery-desktop-reset", move || {
            // Let the invoking page receive its acknowledgement before the
            // owned Next/PGlite process is stopped.
            let state = task_app.state::<DesktopServerState>();
            if state.wait_for_lifecycle_cancel(Duration::from_millis(250))
                || !state.lifecycle_is_current(epoch)
            {
                return;
            }
            let result = (|| -> Result<(), String> {
                if !state.lifecycle_is_current(epoch) {
                    return Err("Desktop workspace reset was superseded".to_string());
                }
                if let Err(err) = navigate_and_show(&task_app, "tauri://localhost/index.html") {
                    eprintln!("Could not show workspace reset progress: {err}");
                }
                if !state.lifecycle_is_current(epoch) {
                    return Err("Desktop workspace reset was superseded".to_string());
                }
                state.stop_runtime();
                if !state.lifecycle_is_current(epoch) {
                    return Err("Desktop workspace reset was superseded".to_string());
                }
                let reset_profile = profile_dirs()?;
                reset_workspace_data(&reset_profile)?;
                refresh_profile_fs_roots(&reset_profile)?;
                if !state.lifecycle_is_current(epoch) {
                    return Err("Desktop workspace reset was superseded".to_string());
                }
                Ok(())
            })();

            match result {
                Ok(()) => boot_desktop_runtime_inner(&task_app, &download_state, epoch),
                Err(err) => {
                    eprintln!("Desktop workspace reset failed: {err}");
                    if state.lifecycle_is_current(epoch) {
                        show_startup_error(&task_app);
                    }
                }
            }
            if state.lifecycle_is_current(epoch) {
                state
                    .runtime_operation
                    .store(RUNTIME_OPERATION_IDLE, Ordering::SeqCst);
            }
        }) {
            state
                .runtime_operation
                .store(RUNTIME_OPERATION_IDLE, Ordering::SeqCst);
            return Err(error);
        }
        Ok(())
    }
}

#[tauri::command]
fn reset_desktop_workspace(
    app: AppHandle,
    download_state: State<'_, Arc<DownloadState>>,
    confirmation: String,
) -> Result<(), String> {
    request_desktop_workspace_reset(app, Arc::clone(download_state.inner()), confirmation.trim())
}

#[tauri::command]
fn retry_desktop_runtime(app: AppHandle, download_state: State<'_, Arc<DownloadState>>) {
    let download_state = Arc::clone(download_state.inner());
    let _ = schedule_desktop_runtime_boot(app, download_state);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let download_state = Arc::new(DownloadState::default());
    let desktop_state = DesktopServerState::default();
    let startup_download_state = Arc::clone(&download_state);
    #[cfg(debug_assertions)]
    let dev_bridge_download_state = Arc::clone(&download_state);
    // Initialize a finite residency budget from current measured hardware.
    // The probe owns platform-specific safety margins; the runtime manager
    // enforces that single startup fact for every registered local engine.
    let detected = vram_probe::detect_budget_mb();
    let residency = Arc::new(ResidencyManager::new(detected));
    // Make the manager reachable from bridge threads (no Tauri State) via
    // a process-global. Ignore the unlikely race — both candidates point at
    // the same logical manager from the user's perspective.
    let _ = RESIDENCY_GLOBAL.set(Arc::clone(&residency));
    let builder = tauri::Builder::default()
        // Must be the first registered plugin so a second launch focuses the
        // existing instance before any other plugin setup runs.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(desktop_state)
        .manage(Arc::clone(&download_state))
        .setup(move |app| {
            // Acquire the resolved-profile OS advisory lock before dev bridge,
            // stale PID cleanup, runtime spawn, or PGlite open. A second instance
            // that races past single-instance must not run backend PID cleanup.
            let profile = match profile_dirs() {
                Ok(profile) => profile,
                Err(err) => {
                    eprintln!("desktop profile unavailable: {err}");
                    return Err(Box::<dyn std::error::Error>::from(err));
                }
            };
            if let Err(err) = acquire_profile_lock_for_startup(
                app.state::<DesktopServerState>().inner(),
                &profile,
            ) {
                eprintln!("desktop profile lock unavailable: {err}");
                return Err(Box::<dyn std::error::Error>::from(err));
            }
            if let Err(err) = initialize_profile_fs_roots(&profile) {
                eprintln!("desktop safe profile filesystem unavailable: {err}");
                return Err(Box::<dyn std::error::Error>::from(err));
            }
            if let Err(err) = clear_stale_workspace_initialization_lock() {
                eprintln!("desktop workspace initialization lock cleanup failed: {err}");
                return Err(Box::<dyn std::error::Error>::from(err));
            }

            #[cfg(debug_assertions)]
            {
                let dev_bridge_result = (|| {
                    let bridge_server = start_desktop_bridge(
                        Arc::clone(&dev_bridge_download_state),
                        workspace_reset_handler(
                            app.handle().clone(),
                            Arc::clone(&dev_bridge_download_state),
                        ),
                    )?;
                    let path = write_desktop_dev_bridge_file(&profile, &bridge_server.bridge)?;
                    Ok::<_, String>((path, bridge_server))
                })();
                match dev_bridge_result {
                    Ok((path, bridge_server)) => {
                        if let Ok(mut guard) =
                            app.state::<DesktopServerState>().dev_bridge_file.lock()
                        {
                            *guard = Some(path);
                        }
                        if let Ok(mut guard) =
                            app.state::<DesktopServerState>().dev_bridge_server.lock()
                        {
                            *guard = Some(bridge_server);
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
            // Cancellation: the watcher is part of the tracked desktop
            // lifecycle and waits on its wakeable shutdown token.
            let app_handle = app.handle().clone();
            app.state::<DesktopServerState>()
                .spawn_lifecycle_task("lunery-runtime-watcher", move || {
                    let mut last_llama_running = false;
                    let mut last_mlx_running = false;
                    let mut last_mlx_phase = String::new();
                    loop {
                        let state = app_handle.state::<DesktopServerState>();
                        if state.wait_for_lifecycle_cancel(Duration::from_secs(2)) {
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
                            if state.lifecycle_is_cancelled() {
                                break;
                            }
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
                })
                .map_err(Box::<dyn std::error::Error>::from)?;
            let startup_app = app.handle().clone();
            let startup_download_state = Arc::clone(&startup_download_state);
            schedule_desktop_runtime_boot(startup_app, startup_download_state)
                .map_err(Box::<dyn std::error::Error>::from)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_runtime_status,
            save_provider_secret,
            delete_provider_secret,
            retry_desktop_runtime,
            reset_desktop_workspace,
            open_desktop_profile_folder,
            detect_hardware,
            probe_local_runtime,
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

/// Returns true only in the hidden, bounded keychain helper subprocess. This
/// runs before Tauri initialisation so a stuck native keychain call can be
/// terminated by the owning desktop process without affecting the app.
pub fn run_keychain_read_helper_if_requested() -> bool {
    secrets::run_keychain_read_helper_if_requested()
}

#[cfg(all(test, unix))]
mod desktop_server_lifecycle_tests {
    use crate::{
        acquire_profile_lock_for_startup, pid_matches_expected_binary, test_global_lock,
        DesktopServerState, ProfileDirs,
    };
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_profile(name: &str) -> ProfileDirs {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("lunery-startup-{name}-{nanos}"));
        let data = root.join("data");
        ProfileDirs {
            root: root.clone(),
            config: root.join("config"),
            data: data.clone(),
            pglite: data.join("pglite"),
            media: data.join("media"),
            models: root.join("models"),
            logs: root.join("logs"),
            runtime: root.join("runtime"),
        }
    }

    #[test]
    fn second_profile_holder_fails_before_pid_cleanup_hook() {
        let profile = unique_profile("second-holder");
        let first = DesktopServerState::default();
        acquire_profile_lock_for_startup(&first, &profile).expect("first profile holder");

        let second = DesktopServerState::default();
        let pid_cleanup_reached = AtomicBool::new(false);
        let result = (|| -> Result<(), String> {
            acquire_profile_lock_for_startup(&second, &profile)?;
            pid_cleanup_reached.store(true, Ordering::SeqCst);
            Ok(())
        })();

        assert!(result.is_err());
        assert!(
            !pid_cleanup_reached.load(Ordering::SeqCst),
            "a second profile holder must fail before stale PID cleanup"
        );
        drop(first);
        drop(second);
        let _ = std::fs::remove_dir_all(&profile.root);
    }

    #[test]
    fn poisoned_profile_lock_holder_fails_closed() {
        let profile = unique_profile("poisoned-holder");
        let state = DesktopServerState::default();
        let _ = std::panic::catch_unwind(|| {
            let _guard = state.profile_lock.lock().expect("profile lock holder");
            panic!("poison profile lock holder");
        });

        let result = acquire_profile_lock_for_startup(&state, &profile);
        assert!(result.is_err(), "poisoned holder must abort startup");
        drop(state);
        let _ = std::fs::remove_dir_all(&profile.root);
    }

    #[test]
    fn shutdown_reaps_runtime_child_and_cleans_runtime_files() {
        let _global = test_global_lock();
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

        assert!(state.lifecycle_is_cancelled());
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
        drop(state);
        crate::secrets::reset_secret_runtime_for_tests();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn shutdown_revocation_wins_against_a_precommit_runtime_task() {
        let _global = test_global_lock();
        let state = Arc::new(DesktopServerState::default());
        let epoch = state.begin_lifecycle_epoch().expect("lifecycle epoch");
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let effects = Arc::new(AtomicUsize::new(0));

        let task_state = Arc::clone(&state);
        let task_entered = Arc::clone(&entered);
        let task_release = Arc::clone(&release);
        let task_effects = Arc::clone(&effects);
        state
            .spawn_lifecycle_task("desktop-precommit-latch", move || {
                task_entered.wait();
                task_release.wait();
                let _commit = task_state
                    .lifecycle_commit
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if task_state.lifecycle_is_current(epoch) {
                    // Models the externally visible child, bridge/PID and event
                    // commits, all protected by the same epoch+commit lock.
                    task_effects.fetch_add(4, Ordering::SeqCst);
                }
            })
            .expect("spawn precommit task");
        entered.wait();

        state.revoke_lifecycle();
        release.wait();
        state.join_lifecycle_tasks();
        assert_eq!(effects.load(Ordering::SeqCst), 0);
        assert!(state.lifecycle_is_cancelled());
        assert!(state.lifecycle_tasks.lock().unwrap().is_empty());
        drop(state);
        crate::secrets::reset_secret_runtime_for_tests();
    }
}

#[cfg(test)]
mod workspace_reset_tests {
    use crate::profile::ProfileDirs;
    use crate::reset_workspace_data;
    #[cfg(unix)]
    use crate::reset_workspace_data_unix;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("lunery-workspace-reset-{name}-{nonce}"))
    }

    fn profile(root: PathBuf) -> ProfileDirs {
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
    fn reset_deletes_workspace_and_recovery_but_preserves_models_connections_and_logs() {
        let dirs = profile(unique_root("contents"));
        for dir in [
            &dirs.config,
            &dirs.pglite,
            &dirs.media,
            &dirs.models,
            &dirs.logs,
        ] {
            std::fs::create_dir_all(dir).expect("create profile fixture");
        }
        std::fs::create_dir_all(dirs.data.join("recovery/pglite-old"))
            .expect("create recovery fixture");
        std::fs::write(dirs.pglite.join("PG_VERSION"), b"broken").expect("seed database");
        std::fs::write(dirs.media.join("asset.webp"), b"asset").expect("seed media");
        std::fs::write(dirs.data.join("recovery/pglite-old/PG_VERSION"), b"old")
            .expect("seed recovery");
        std::fs::write(dirs.config.join("provider-connections.json"), b"{}")
            .expect("seed connections");
        std::fs::write(dirs.models.join("model.gguf"), b"model").expect("seed model");
        std::fs::write(dirs.logs.join("desktop-runtime.log"), b"log").expect("seed log");

        reset_workspace_data(&dirs).expect("reset workspace");

        assert!(dirs.pglite.is_dir());
        assert!(dirs.media.is_dir());
        assert!(!dirs.pglite.join("PG_VERSION").exists());
        assert!(!dirs.media.join("asset.webp").exists());
        assert!(!dirs.data.join("recovery").exists());
        assert!(dirs.config.join("provider-connections.json").exists());
        assert!(dirs.models.join("model.gguf").exists());
        assert!(dirs.logs.join("desktop-runtime.log").exists());

        let _ = std::fs::remove_dir_all(dirs.root);
    }

    #[cfg(unix)]
    #[test]
    fn reset_unlinks_a_data_symlink_without_deleting_its_target() {
        use std::os::unix::fs::symlink;

        let dirs = profile(unique_root("symlink"));
        let external = unique_root("external");
        std::fs::create_dir_all(&dirs.root).expect("create profile root");
        std::fs::create_dir_all(&external).expect("create external target");
        std::fs::write(external.join("keep.txt"), b"keep").expect("seed external target");
        symlink(&external, &dirs.data).expect("link data outside profile");

        reset_workspace_data(&dirs).expect("replace data symlink");

        assert!(dirs.data.is_dir());
        assert!(!std::fs::symlink_metadata(&dirs.data)
            .expect("inspect recreated data")
            .file_type()
            .is_symlink());
        assert!(external.join("keep.txt").exists());

        let _ = std::fs::remove_dir_all(dirs.root);
        let _ = std::fs::remove_dir_all(external);
    }

    #[cfg(unix)]
    #[test]
    fn reset_rejects_a_symlinked_profile_root() {
        use std::os::unix::fs::symlink;

        let link_parent = unique_root("linked-parent");
        let actual_root = unique_root("linked-target");
        let linked_root = link_parent.join("profile");
        std::fs::create_dir_all(&link_parent).expect("create link parent");
        std::fs::create_dir_all(actual_root.join("data")).expect("create linked profile target");
        std::fs::write(actual_root.join("data/keep.txt"), b"keep")
            .expect("seed linked profile target");
        symlink(&actual_root, &linked_root).expect("link profile root");

        assert!(reset_workspace_data(&profile(linked_root)).is_err());
        assert!(actual_root.join("data/keep.txt").exists());

        let _ = std::fs::remove_dir_all(link_parent);
        let _ = std::fs::remove_dir_all(actual_root);
    }

    #[cfg(unix)]
    #[test]
    fn reset_rejects_root_swap_after_pin_without_touching_outside_data() {
        use std::os::unix::fs::symlink;

        let dirs = profile(unique_root("root-swap"));
        let moved_root = unique_root("root-swap-moved");
        let outside = unique_root("root-swap-outside");
        std::fs::create_dir_all(&dirs.data).expect("create profile data");
        std::fs::write(dirs.data.join("profile.txt"), b"profile").expect("seed profile");
        std::fs::create_dir_all(outside.join("data")).expect("create outside data");
        std::fs::write(outside.join("data/sentinel.txt"), b"outside-sentinel")
            .expect("seed outside sentinel");

        let error = reset_workspace_data_unix(&dirs, || {
            std::fs::rename(&dirs.root, &moved_root).expect("move pinned profile root");
            symlink(&outside, &dirs.root).expect("replace profile root with symlink");
        })
        .expect_err("root replacement must fail closed");

        assert!(error.contains("Profile root changed"));
        assert_eq!(
            std::fs::read(outside.join("data/sentinel.txt")).expect("outside sentinel"),
            b"outside-sentinel"
        );
        assert_eq!(
            std::fs::read(moved_root.join("data/profile.txt")).expect("profile data preserved"),
            b"profile"
        );
        std::fs::remove_file(&dirs.root).expect("remove root symlink");
        std::fs::remove_dir_all(moved_root).expect("remove moved profile");
        std::fs::remove_dir_all(outside).expect("remove outside fixture");
    }

    #[test]
    fn reset_rejects_parent_traversal_and_broad_roots() {
        let fixture = unique_root("unsafe");
        let victim = fixture.join("victim");
        std::fs::create_dir_all(victim.join("data")).expect("create victim data");
        std::fs::write(victim.join("data/keep.txt"), b"keep").expect("seed victim data");

        let traversing = profile(fixture.join("nested/../victim"));
        assert!(reset_workspace_data(&traversing).is_err());
        assert!(victim.join("data/keep.txt").exists());
        assert!(reset_workspace_data(&profile(PathBuf::from("/"))).is_err());

        let _ = std::fs::remove_dir_all(fixture);
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
    #[cfg(debug_assertions)]
    use crate::profile::ProfileDirs;
    use crate::{
        bundled_desktop_server_root, command_line_matches_expected_binary, test_global_lock,
    };
    #[cfg(debug_assertions)]
    use crate::{write_desktop_dev_bridge_file, DesktopBridge};
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

    #[cfg(debug_assertions)]
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
    fn bundled_server_root_accepts_only_tauri_resource_layouts() {
        let resource_dir = unique_test_profile("tauri-resources");
        let cwd_fallback = resource_dir.join("cwd").join("desktop-server");
        std::fs::create_dir_all(&cwd_fallback).expect("create unrelated desktop server");

        assert!(bundled_desktop_server_root(&resource_dir).is_err());

        let direct = resource_dir.join("desktop-server");
        std::fs::create_dir_all(&direct).expect("create direct resource layout");
        assert_eq!(
            bundled_desktop_server_root(&resource_dir).expect("direct layout"),
            direct
        );
        std::fs::remove_dir_all(resource_dir.join("desktop-server")).expect("remove direct layout");

        let tauri_up = resource_dir.join("_up_").join("desktop-server");
        std::fs::create_dir_all(&tauri_up).expect("create _up_ resource layout");
        assert_eq!(
            bundled_desktop_server_root(&resource_dir).expect("_up_ layout"),
            tauri_up
        );

        let _ = std::fs::remove_dir_all(resource_dir);
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

    #[cfg(all(unix, debug_assertions))]
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
