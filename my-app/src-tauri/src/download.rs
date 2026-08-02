use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Component, Path, PathBuf};
#[cfg(unix)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;

use crate::get_http_client_with_connect_timeout;
use crate::profile::profile_models_root_path;

/// Wakeable process-local cancellation for download jobs.
///
/// Uses a `watch` channel (not `Notify::notify_waiters`) so a cancel that races
/// between the flag check and the waiter registration cannot lose the wakeup.
/// Waiters blocked on headers, body/read-idle, on-disk hashing, or final flush
/// observe cancellation deterministically.
#[derive(Debug)]
pub(crate) struct DownloadCancel {
    tx: watch::Sender<bool>,
}

impl Default for DownloadCancel {
    fn default() -> Self {
        Self::new()
    }
}

impl DownloadCancel {
    pub(crate) fn new() -> Self {
        let (tx, _) = watch::channel(false);
        Self { tx }
    }

    pub(crate) fn request(&self) {
        // `send` drops the value when there are no active receivers. Jobs can
        // be canceled between awaited operations, so retain the flag even
        // when no waiter is currently subscribed.
        self.tx.send_replace(true);
    }

    pub(crate) fn is_canceled(&self) -> bool {
        *self.tx.borrow()
    }

    pub(crate) async fn cancelled(&self) {
        let mut rx = self.tx.subscribe();
        if *rx.borrow() {
            return;
        }
        while rx.changed().await.is_ok() {
            if *rx.borrow() {
                return;
            }
        }
        // Sender dropped — treat as canceled so waiters cannot hang forever.
    }
}

/// Artifact policy around the non-preemptible OS rename:
/// - cancel observed **before** rename begins → keep `.part`, terminal `canceled`
/// - cancel observed **after** successful rename → keep verified dest, terminal
///   `canceled` (never transition to `ready`)
///
/// Rename itself cannot be preempted once the OS op begins.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FinalizeDecision {
    /// Still cancelable; leave `.part` in place and mark canceled.
    CancelKeepPart,
    /// Proceed to the OS rename (not cancel-preemptible once started).
    ProceedRename,
    /// Rename already succeeded; cancel wins over ready.
    CancelKeepDest,
    /// Rename succeeded and cancel was not observed — mark ready.
    MarkReady,
}

pub(crate) fn finalize_decision_before_rename(canceled: bool) -> FinalizeDecision {
    if canceled {
        FinalizeDecision::CancelKeepPart
    } else {
        FinalizeDecision::ProceedRename
    }
}

pub(crate) fn finalize_decision_after_rename(canceled: bool) -> FinalizeDecision {
    if canceled {
        FinalizeDecision::CancelKeepDest
    } else {
        FinalizeDecision::MarkReady
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct DownloadTimeouts {
    pub(crate) connect: Duration,
    pub(crate) headers: Duration,
    pub(crate) read_idle: Duration,
}

impl Default for DownloadTimeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(30),
            headers: Duration::from_secs(60),
            read_idle: Duration::from_secs(60),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum WaitOutcome<T> {
    Ready(T),
    Canceled,
    TimedOut,
}

async fn race_cancel_timeout<T, F>(
    cancel: &DownloadCancel,
    timeout: Duration,
    fut: F,
) -> WaitOutcome<T>
where
    F: Future<Output = T>,
{
    tokio::select! {
        biased;
        _ = cancel.cancelled() => WaitOutcome::Canceled,
        _ = tokio::time::sleep(timeout) => WaitOutcome::TimedOut,
        value = fut => WaitOutcome::Ready(value),
    }
}

async fn await_managed_file_io<F>(operation: F) -> std::io::Result<()>
where
    F: Future<Output = std::io::Result<()>>,
{
    operation.await
}

// ---------------------------------------------------------------------------
// Download state (managed by Tauri + shared with bridge handler)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct JobSnapshot {
    pub status: String,
    pub received: u64,
    pub total: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DownloadRequestIdentity {
    url: String,
    dest: String,
    sha256: Option<String>,
}

pub(crate) struct DownloadJob {
    pub(crate) status: String,
    pub(crate) received: u64,
    pub(crate) total: u64,
    pub(crate) error: Option<String>,
    pub(crate) destination: PathBuf,
    pub(crate) owns_destination: bool,
    pub(crate) finished_at: Option<Instant>,
    pub(crate) request_identity: Option<DownloadRequestIdentity>,
    pub(crate) cancel: Arc<DownloadCancel>,
    /// Broadcast channel sender — SSE bridge subscribers drain from a receiver.
    pub(crate) tx: tokio::sync::broadcast::Sender<JobSnapshot>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DownloadCancelRequest {
    Accepted,
    Pending,
    NotFound,
    Terminal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DownloadReservation {
    Created,
    Existing,
    Canceled,
}

#[derive(Clone, Copy, Debug, Default)]
struct DownloadReservationGuards {
    destination_delete_leased: bool,
    canceled_before_reservation: bool,
}

impl DownloadJob {
    pub(crate) fn snapshot(&self) -> JobSnapshot {
        JobSnapshot {
            status: self.status.clone(),
            received: self.received,
            total: self.total,
            error: self.error.clone(),
        }
    }
}

/// Shared download state — managed via Tauri's app.manage() AND arc-cloned into
/// bridge handler threads so the SSE path can drain progress from the same store.
struct DestinationDeleteLease {
    lease_id: String,
    expires_at: Instant,
}

#[derive(Default)]
pub struct DownloadState(
    pub(crate) Mutex<HashMap<String, DownloadJob>>,
    Mutex<HashMap<PathBuf, DestinationDeleteLease>>,
    Mutex<usize>,
    Condvar,
    Mutex<HashMap<String, Instant>>,
);

const TERMINAL_HISTORY_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_TERMINAL_HISTORY: usize = 128;
const DESTINATION_DELETE_LEASE_TTL: Duration = Duration::from_secs(60);
const PENDING_CANCEL_TTL: Duration = Duration::from_secs(2 * 60);
const MAX_PENDING_CANCELS: usize = 128;

impl DownloadState {
    pub(crate) fn begin_background_task(&self) {
        let mut active = self
            .2
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *active += 1;
    }

    pub(crate) fn finish_background_task(&self) {
        let mut active = self
            .2
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *active = active.saturating_sub(1);
        self.3.notify_all();
    }

    pub(crate) fn request_cancel_all_active(&self) {
        let jobs = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for job in jobs.values() {
            if !is_terminal_download_status(&job.status) {
                job.cancel.request();
            }
        }
    }

    pub(crate) fn request_cancel_job(&self, job_id: &str) -> DownloadCancelRequest {
        let jobs = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(job) = jobs.get(job_id) else {
            if !is_canonical_uuid(job_id) {
                return DownloadCancelRequest::NotFound;
            }
            let now = Instant::now();
            let mut pending = self
                .4
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            pending
                .retain(|_, created| now.saturating_duration_since(*created) <= PENDING_CANCEL_TTL);
            if pending.len() >= MAX_PENDING_CANCELS && !pending.contains_key(job_id) {
                if let Some(oldest) = pending
                    .iter()
                    .min_by_key(|(_, created)| **created)
                    .map(|(id, _)| id.clone())
                {
                    pending.remove(&oldest);
                }
            }
            pending.insert(job_id.to_string(), now);
            return DownloadCancelRequest::Pending;
        };
        if is_terminal_download_status(&job.status) {
            return DownloadCancelRequest::Terminal;
        }
        // Linearizes with update_job_status, which holds this same mutex while
        // folding any later ready/error commit into canceled.
        job.cancel.request();
        DownloadCancelRequest::Accepted
    }

    pub(crate) fn wait_for_background_tasks(&self) {
        let active = self
            .2
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _guard = self
            .3
            .wait_while(active, |count| *count > 0)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }

    #[cfg(test)]
    fn reserve_job(
        &self,
        job_id: &str,
        destination: PathBuf,
        cancel: Arc<DownloadCancel>,
        tx: tokio::sync::broadcast::Sender<JobSnapshot>,
    ) -> Result<(), String> {
        self.reserve_job_at(job_id, destination, cancel, tx, Instant::now())
    }

    #[cfg(test)]
    fn reserve_job_at(
        &self,
        job_id: &str,
        destination: PathBuf,
        cancel: Arc<DownloadCancel>,
        tx: tokio::sync::broadcast::Sender<JobSnapshot>,
        now: Instant,
    ) -> Result<(), String> {
        self.reserve_job_common(job_id, destination, None, cancel, tx, now)
            .map(|_| ())
    }

    fn reserve_request_job(
        &self,
        job_id: &str,
        destination: PathBuf,
        request_identity: DownloadRequestIdentity,
        cancel: Arc<DownloadCancel>,
        tx: tokio::sync::broadcast::Sender<JobSnapshot>,
    ) -> Result<DownloadReservation, String> {
        self.reserve_job_common(
            job_id,
            destination,
            Some(request_identity),
            cancel,
            tx,
            Instant::now(),
        )
    }

    fn reserve_job_common(
        &self,
        job_id: &str,
        destination: PathBuf,
        request_identity: Option<DownloadRequestIdentity>,
        cancel: Arc<DownloadCancel>,
        tx: tokio::sync::broadcast::Sender<JobSnapshot>,
        now: Instant,
    ) -> Result<DownloadReservation, String> {
        let mut deletion_leases = self
            .1
            .lock()
            .map_err(|_| "Download deletion lease lock poisoned".to_string())?;
        deletion_leases.retain(|_, lease| lease.expires_at > now);
        let mut jobs = self
            .0
            .lock()
            .map_err(|_| "Download state lock poisoned".to_string())?;
        let mut pending = self
            .4
            .lock()
            .map_err(|_| "Download pending-cancel lock poisoned".to_string())?;
        pending.retain(|_, created| now.saturating_duration_since(*created) <= PENDING_CANCEL_TTL);
        let canceled_before_reservation = pending.remove(job_id).is_some();
        reserve_download_job_for_request(
            &mut jobs,
            job_id,
            destination.clone(),
            request_identity,
            cancel,
            tx,
            DownloadReservationGuards {
                destination_delete_leased: deletion_leases.contains_key(&destination),
                canceled_before_reservation,
            },
        )
    }

    fn existing_request_matches(
        &self,
        job_id: &str,
        request_identity: &DownloadRequestIdentity,
    ) -> Result<Option<bool>, String> {
        let jobs = self
            .0
            .lock()
            .map_err(|_| "Download state lock poisoned".to_string())?;
        Ok(jobs
            .get(job_id)
            .map(|job| job.request_identity.as_ref() == Some(request_identity)))
    }

    pub(crate) fn acquire_destination_delete_lease(
        &self,
        destination: PathBuf,
        lease_id: &str,
    ) -> Result<(), String> {
        self.acquire_destination_delete_lease_at(destination, lease_id, Instant::now())
    }

    fn acquire_destination_delete_lease_at(
        &self,
        destination: PathBuf,
        lease_id: &str,
        now: Instant,
    ) -> Result<(), String> {
        let mut leases = self
            .1
            .lock()
            .map_err(|_| "Download deletion lease lock poisoned".to_string())?;
        leases.retain(|_, lease| lease.expires_at > now);
        if let Some(existing) = leases.get(&destination) {
            if existing.lease_id != lease_id {
                return Err("Model file is already being deleted".to_string());
            }
        }
        leases.insert(
            destination,
            DestinationDeleteLease {
                lease_id: lease_id.to_string(),
                expires_at: now + DESTINATION_DELETE_LEASE_TTL,
            },
        );
        Ok(())
    }

    pub(crate) fn release_destination_delete_lease(&self, destination: &Path, lease_id: &str) {
        if let Ok(mut leases) = self.1.lock() {
            if leases.get(destination).map(|lease| lease.lease_id.as_str()) == Some(lease_id) {
                leases.remove(destination);
            }
        }
    }
}

pub(crate) fn canonical_download_destination(value: &str) -> Result<PathBuf, String> {
    let destination = validate_hf_download_dest(value)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "Download destination must include a parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|err| format!("Could not create model directory: {err}"))?;
    let root = canonical_models_root_for_path(&destination)?;
    let parent = parent
        .canonicalize()
        .map_err(|err| format!("Could not verify model directory: {err}"))?;
    if !parent.starts_with(&root) {
        return Err("Download destination escapes the model directory".to_string());
    }
    Ok(parent.join(
        destination
            .file_name()
            .ok_or_else(|| "Download destination must point to a file".to_string())?,
    ))
}

struct SecureDownloadTarget {
    destination: PathBuf,
    part_path: PathBuf,
    #[cfg(unix)]
    parent: std::fs::File,
    #[cfg(unix)]
    destination_name: std::ffi::OsString,
    #[cfg(unix)]
    part_name: std::ffi::OsString,
    #[cfg(unix)]
    part_identity: Mutex<Option<SecureFileIdentity>>,
    #[cfg(unix)]
    destination_identity: Mutex<Option<SecureFileIdentity>>,
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SecureFileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
static DOWNLOAD_QUARANTINE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(unix)]
impl SecureFileIdentity {
    fn from_file(file: &std::fs::File) -> std::io::Result<Self> {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

impl SecureDownloadTarget {
    fn pin(destination: PathBuf) -> Result<Self, String> {
        let root = canonical_models_root_for_path(&destination)?;
        Self::pin_in_root(root, destination)
    }

    fn pin_in_root(root: PathBuf, destination: PathBuf) -> Result<Self, String> {
        let parent_path = destination
            .parent()
            .ok_or_else(|| "Download destination must include a parent directory".to_string())?
            .to_path_buf();
        if !parent_path.starts_with(&root) {
            return Err("Download destination escapes the model directory".to_string());
        }
        let destination_name = destination
            .file_name()
            .ok_or_else(|| "Download destination must point to a file".to_string())?
            .to_os_string();
        let mut part_name = destination_name.clone();
        part_name.push(".part");
        let part_path = parent_path.join(&part_name);

        #[cfg(unix)]
        {
            use rustix::fs::{open, openat, Mode, OFlags};
            let mut directory = open(
                &root,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .map_err(|error| format!("Could not pin model root: {error}"))?;
            let relative_parent = parent_path
                .strip_prefix(&root)
                .map_err(|_| "Download destination escapes the model directory".to_string())?;
            for component in relative_parent.components() {
                let Component::Normal(name) = component else {
                    return Err("Download destination contains an unsafe component".to_string());
                };
                directory = openat(
                    &directory,
                    name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                    Mode::empty(),
                )
                .map_err(|error| format!("Could not pin model directory: {error}"))?;
            }
            Ok(Self {
                destination,
                part_path,
                parent: std::fs::File::from(directory),
                destination_name,
                part_name,
                part_identity: Mutex::new(None),
                destination_identity: Mutex::new(None),
            })
        }

        #[cfg(not(unix))]
        {
            let _ = (destination, part_path);
            Err("Secure download mutations are unavailable on this platform".to_string())
        }
    }

    #[cfg(unix)]
    fn open_at(
        &self,
        name: &std::ffi::OsStr,
        flags: rustix::fs::OFlags,
    ) -> std::io::Result<std::fs::File> {
        use rustix::fs::{openat, Mode, OFlags};
        let descriptor = openat(
            &self.parent,
            name,
            flags | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
        )?;
        let file = std::fs::File::from(descriptor);
        if !file.metadata()?.file_type().is_file() {
            return Err(std::io::Error::other(
                "download target is not a regular file",
            ));
        }
        Ok(file)
    }

    fn open_destination_read(&self) -> std::io::Result<Option<tokio::fs::File>> {
        #[cfg(unix)]
        {
            match self.open_at(&self.destination_name, rustix::fs::OFlags::RDONLY) {
                Ok(file) => {
                    let identity = SecureFileIdentity::from_file(&file)?;
                    *self
                        .destination_identity
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(identity);
                    Ok(Some(tokio::fs::File::from_std(file)))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error),
            }
        }
        #[cfg(not(unix))]
        {
            Err(std::io::Error::other(
                "secure download mutations are unavailable on this platform",
            ))
        }
    }

    fn part_len(&self) -> std::io::Result<u64> {
        #[cfg(unix)]
        {
            match self.open_at(&self.part_name, rustix::fs::OFlags::RDONLY) {
                Ok(file) => file.metadata().map(|metadata| metadata.len()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
                Err(error) => Err(error),
            }
        }
        #[cfg(not(unix))]
        {
            Err(std::io::Error::other(
                "secure download mutations are unavailable on this platform",
            ))
        }
    }

    fn open_part(&self, resume: bool) -> std::io::Result<tokio::fs::File> {
        #[cfg(unix)]
        {
            use rustix::fs::OFlags;
            let flags = if resume {
                OFlags::RDWR | OFlags::CREATE | OFlags::APPEND
            } else {
                OFlags::RDWR | OFlags::CREATE | OFlags::TRUNC
            };
            let file = self.open_at(&self.part_name, flags)?;
            let identity = SecureFileIdentity::from_file(&file)?;
            *self
                .part_identity
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(identity);
            Ok(tokio::fs::File::from_std(file))
        }
        #[cfg(not(unix))]
        {
            let _ = resume;
            Err(std::io::Error::other(
                "secure download mutations are unavailable on this platform",
            ))
        }
    }

    fn open_part_read(&self) -> std::io::Result<tokio::fs::File> {
        #[cfg(unix)]
        {
            let file = self.open_at(&self.part_name, rustix::fs::OFlags::RDONLY)?;
            let identity = SecureFileIdentity::from_file(&file)?;
            *self
                .part_identity
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(identity);
            Ok(tokio::fs::File::from_std(file))
        }
        #[cfg(not(unix))]
        {
            Err(std::io::Error::other(
                "secure download mutations are unavailable on this platform",
            ))
        }
    }

    #[cfg(unix)]
    fn expected_identity(
        identity: &Mutex<Option<SecureFileIdentity>>,
        label: &str,
    ) -> std::io::Result<SecureFileIdentity> {
        identity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .ok_or_else(|| {
                std::io::Error::other(format!(
                    "{label} has no pinned file identity; refusing pathname mutation"
                ))
            })
    }

    #[cfg(unix)]
    fn quarantine_entry(
        &self,
        name: &std::ffi::OsStr,
        identity: &Mutex<Option<SecureFileIdentity>>,
        label: &str,
    ) -> std::io::Result<()> {
        use rustix::fs::{renameat_with, RenameFlags};

        let expected = Self::expected_identity(identity, label)?;
        let current = match self.open_at(name, rustix::fs::OFlags::RDONLY) {
            Ok(file) => SecureFileIdentity::from_file(&file)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let sequence = DOWNLOAD_QUARANTINE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let mut quarantine_name = name.to_os_string();
        quarantine_name.push(format!(
            ".lunery-quarantine-{}-{sequence}",
            std::process::id()
        ));
        renameat_with(
            &self.parent,
            name,
            &self.parent,
            &quarantine_name,
            RenameFlags::NOREPLACE,
        )?;

        let quarantined = self.open_at(&quarantine_name, rustix::fs::OFlags::RDONLY)?;
        let quarantined_identity = SecureFileIdentity::from_file(&quarantined)?;
        if current != expected || quarantined_identity != expected {
            return Err(std::io::Error::other(format!(
                "{label} was replaced during cleanup; the replacement was preserved as {}",
                quarantine_name.to_string_lossy()
            )));
        }
        Ok(())
    }

    fn unlink_part(&self) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            self.quarantine_entry(&self.part_name, &self.part_identity, "partial download")
        }
        #[cfg(not(unix))]
        {
            Err(std::io::Error::other(
                "secure download mutations are unavailable on this platform",
            ))
        }
    }

    fn unlink_destination(&self) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            self.quarantine_entry(
                &self.destination_name,
                &self.destination_identity,
                "download destination",
            )
        }
        #[cfg(not(unix))]
        {
            Err(std::io::Error::other(
                "secure download mutations are unavailable on this platform",
            ))
        }
    }

    fn rename_part_to_destination(&self) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use rustix::fs::{renameat_with, RenameFlags};

            // Bind promotion to the exact inode that was written/hashed. A
            // regular-file replacement is just as unsafe as a symlink swap.
            let expected = Self::expected_identity(&self.part_identity, "partial download")?;
            let part = self.open_at(&self.part_name, rustix::fs::OFlags::RDONLY)?;
            if SecureFileIdentity::from_file(&part)? != expected {
                return Err(std::io::Error::other(
                    "partial download was replaced before finalization",
                ));
            }
            match self.open_at(&self.destination_name, rustix::fs::OFlags::RDONLY) {
                Ok(_) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::AlreadyExists,
                        "download destination appeared during transfer",
                    ))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            renameat_with(
                &self.parent,
                &self.part_name,
                &self.parent,
                &self.destination_name,
                RenameFlags::NOREPLACE,
            )?;
            let destination = self.open_at(&self.destination_name, rustix::fs::OFlags::RDONLY)?;
            let destination_identity = SecureFileIdentity::from_file(&destination)?;
            if destination_identity != expected {
                return Err(std::io::Error::other(
                    "download destination was replaced after finalization",
                ));
            }
            *self
                .destination_identity
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(expected);
            Ok(())
        }
        #[cfg(not(unix))]
        {
            Err(std::io::Error::other(
                "secure download mutations are unavailable on this platform",
            ))
        }
    }
}

/// Synchronous entry point for starting a download job — called from the bridge
/// handler. Validates state, inserts the job record, then spawns an async task
/// on Tauri's runtime (no second runtime created).
pub(crate) fn hf_download_start_inner(
    url: String,
    dest: String,
    sha256: Option<String>,
    job_id: String,
    state: Arc<DownloadState>,
) -> Result<(), String> {
    hf_download_start_inner_for_platform(url, dest, sha256, job_id, state, cfg!(windows))
}

fn hf_download_start_inner_for_platform(
    url: String,
    dest: String,
    sha256: Option<String>,
    job_id: String,
    state: Arc<DownloadState>,
    is_windows: bool,
) -> Result<(), String> {
    if !is_canonical_uuid(&job_id) {
        return Err("Invalid job_id".to_string());
    }
    ensure_secure_download_mutation_platform(is_windows)?;

    let request_identity = DownloadRequestIdentity {
        url: url.clone(),
        dest: dest.clone(),
        sha256: sha256.clone(),
    };
    match state.existing_request_matches(&job_id, &request_identity)? {
        Some(true) => return Ok(()),
        Some(false) => return Err("Job ID conflicts with a different download request".to_string()),
        None => {}
    }

    let url = validate_hf_download_url(&url)?;
    let dest_path = validate_hf_download_dest(&dest)?;
    let part_path = PathBuf::from(format!("{}.part", dest_path.to_string_lossy()));
    if dest_path
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
        || part_path
            .symlink_metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
    {
        return Err("Download destination must not be a symlink".to_string());
    }
    // Best-effort disk pre-check before any network traffic. The real check
    // against the model's actual size happens in the streaming task once the
    // Content-Length header arrives (see `run_download_task`).
    {
        let parent = dest_path.parent().unwrap_or(&dest_path);
        let available = available_disk_bytes(parent).unwrap_or(0);
        if available < 1024 * 1024 * 1024 {
            return Err("Insufficient disk space (< 1 GiB available)".to_string());
        }
    }

    let destination = canonical_download_destination(&dest_path.to_string_lossy())?;
    let secure_target = SecureDownloadTarget::pin(destination.clone())?;
    let dest = secure_target.destination.to_string_lossy().to_string();
    let part_path = secure_target.part_path.clone();

    // Set up a broadcast channel for SSE progress ticks (capacity 64 frames).
    let (tx, _) = tokio::sync::broadcast::channel::<JobSnapshot>(64);
    let cancel = Arc::new(DownloadCancel::new());

    match state.reserve_request_job(
        &job_id,
        destination,
        request_identity,
        Arc::clone(&cancel),
        tx.clone(),
    )? {
        DownloadReservation::Existing => return Ok(()),
        DownloadReservation::Canceled => return Ok(()),
        DownloadReservation::Created => {}
    }
    state.begin_background_task();

    let state_clone = Arc::clone(&state);
    tauri::async_runtime::spawn(async move {
        let _completion = DownloadTaskCompletionGuard {
            job_id: job_id.clone(),
            state: Arc::clone(&state_clone),
            tx: tx.clone(),
        };
        run_download_task(DownloadTask {
            url,
            dest,
            part_path,
            sha256,
            job_id,
            state: state_clone,
            tx,
            cancel,
            timeouts: DownloadTimeouts::default(),
            secure_target,
            #[cfg(test)]
            hash_test_hook: None,
        })
        .await;
    });

    Ok(())
}

fn ensure_secure_download_mutation_platform(is_windows: bool) -> Result<(), String> {
    if is_windows {
        return Err(
            "Hugging Face downloads are unavailable on Windows until reparse-safe file operations are enabled"
                .to_string(),
        );
    }
    Ok(())
}

fn is_canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

struct DownloadTaskCompletionGuard {
    job_id: String,
    state: Arc<DownloadState>,
    tx: tokio::sync::broadcast::Sender<JobSnapshot>,
}

impl Drop for DownloadTaskCompletionGuard {
    fn drop(&mut self) {
        // Normal paths already committed a terminal state. If an async task
        // panics or returns early while still active, fail it closed so bridge
        // shutdown cannot wait forever on an orphaned destination owner.
        update_job_status(
            &self.state,
            &self.job_id,
            &self.tx,
            "error",
            0,
            0,
            Some("Download task stopped unexpectedly.".to_string()),
        );
        self.state.finish_background_task();
    }
}

fn is_terminal_download_status(status: &str) -> bool {
    matches!(status, "ready" | "error" | "canceled")
}

fn prune_download_history(jobs: &mut HashMap<String, DownloadJob>, now: Instant) {
    jobs.retain(|_, job| {
        job.owns_destination
            || job
                .finished_at
                .map(|finished| now.saturating_duration_since(finished) <= TERMINAL_HISTORY_TTL)
                .unwrap_or(true)
    });

    let mut terminal = jobs
        .iter()
        .filter(|(_, job)| !job.owns_destination)
        .map(|(job_id, job)| (job_id.clone(), job.finished_at.unwrap_or(now)))
        .collect::<Vec<_>>();
    if terminal.len() <= MAX_TERMINAL_HISTORY {
        return;
    }
    terminal.sort_by_key(|(_, finished_at)| *finished_at);
    let remove_count = terminal.len() - MAX_TERMINAL_HISTORY;
    for (job_id, _) in terminal.into_iter().take(remove_count) {
        jobs.remove(&job_id);
    }
}

#[cfg(test)]
fn reserve_download_job(
    jobs: &mut HashMap<String, DownloadJob>,
    job_id: &str,
    destination: PathBuf,
    cancel: Arc<DownloadCancel>,
    tx: tokio::sync::broadcast::Sender<JobSnapshot>,
) -> Result<(), String> {
    reserve_download_job_for_request(
        jobs,
        job_id,
        destination,
        None,
        cancel,
        tx,
        DownloadReservationGuards::default(),
    )
    .map(|_| ())
}

fn reserve_download_job_for_request(
    jobs: &mut HashMap<String, DownloadJob>,
    job_id: &str,
    destination: PathBuf,
    request_identity: Option<DownloadRequestIdentity>,
    cancel: Arc<DownloadCancel>,
    tx: tokio::sync::broadcast::Sender<JobSnapshot>,
    guards: DownloadReservationGuards,
) -> Result<DownloadReservation, String> {
    prune_download_history(jobs, Instant::now());
    if let Some(existing) = jobs.get(job_id) {
        if request_identity.is_some() && existing.request_identity == request_identity {
            return Ok(DownloadReservation::Existing);
        }
        return Err("Job ID conflicts with a different download request".to_string());
    }
    if guards.destination_delete_leased && !guards.canceled_before_reservation {
        return Err("Model file is being deleted".to_string());
    }
    if !guards.canceled_before_reservation
        && jobs
            .values()
            .any(|job| job.owns_destination && job.destination == destination)
    {
        return Err("Download destination already has an active job".to_string());
    }
    if guards.canceled_before_reservation {
        cancel.request();
    }
    jobs.insert(
        job_id.to_string(),
        DownloadJob {
            status: if guards.canceled_before_reservation {
                "canceled".to_string()
            } else {
                "queued".to_string()
            },
            received: 0,
            total: 0,
            error: None,
            destination,
            owns_destination: !guards.canceled_before_reservation,
            finished_at: guards.canceled_before_reservation.then(Instant::now),
            request_identity,
            cancel,
            tx,
        },
    );
    Ok(if guards.canceled_before_reservation {
        DownloadReservation::Canceled
    } else {
        DownloadReservation::Created
    })
}

/// Available bytes on the volume holding `path` (longest mount-point match).
pub(crate) fn available_disk_bytes(path: &std::path::Path) -> Option<u64> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    disks
        .iter()
        .filter(|d| path.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}

pub(crate) fn models_root_path() -> Result<PathBuf, String> {
    profile_models_root_path()
}

pub(crate) fn models_root_paths() -> Result<Vec<PathBuf>, String> {
    Ok(vec![profile_models_root_path()?])
}

fn models_root_for_path(path: &Path) -> Result<PathBuf, String> {
    models_root_paths()?
        .into_iter()
        .find(|root| path.starts_with(root))
        .ok_or_else(|| "Download destination must live under the model cache".to_string())
}

pub(crate) fn canonical_models_roots() -> Result<Vec<PathBuf>, String> {
    let primary = models_root_path()?;
    let mut roots = Vec::new();
    for root in models_root_paths()? {
        if root == primary || root.exists() {
            std::fs::create_dir_all(&root)
                .map_err(|err| format!("Could not create models root: {err}"))?;
            let canonical = root
                .canonicalize()
                .map_err(|err| format!("Could not verify models root: {err}"))?;
            if !roots.iter().any(|existing| existing == &canonical) {
                roots.push(canonical);
            }
        }
    }
    Ok(roots)
}

fn canonical_models_root_for_path(path: &Path) -> Result<PathBuf, String> {
    let root = models_root_for_path(path)?;
    std::fs::create_dir_all(&root).map_err(|err| format!("Could not create models root: {err}"))?;
    root.canonicalize()
        .map_err(|err| format!("Could not verify models root: {err}"))
}

pub(crate) fn validate_hf_download_url(value: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(value).map_err(|_| "Invalid download URL".to_string())?;
    if url.scheme() != "https" {
        return Err("Model downloads must use HTTPS".to_string());
    }
    if url.host_str() != Some("huggingface.co") {
        return Err("Only huggingface.co model downloads are allowed".to_string());
    }

    let segments: Vec<&str> = url
        .path_segments()
        .map(|parts| parts.collect())
        .unwrap_or_default();
    let Some(resolve_index) = segments.iter().position(|segment| *segment == "resolve") else {
        return Err("Model downloads must use Hugging Face /resolve/ artifact URLs".to_string());
    };
    if resolve_index < 2 || resolve_index + 2 >= segments.len() {
        return Err("Model downloads must point to a Hugging Face model artifact".to_string());
    }
    if segments
        .iter()
        .any(|segment| *segment == "blob" || *segment == "tree")
    {
        return Err("Model downloads must use Hugging Face /resolve/ artifact URLs".to_string());
    }
    let file_name = segments.last().copied().unwrap_or_default().to_lowercase();
    if !(file_name.ends_with(".gguf")
        || file_name.ends_with(".safetensors")
        || file_name.ends_with(".bin"))
    {
        return Err("Model downloads must point to a supported model file".to_string());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

pub(crate) fn validate_hf_download_dest(value: &str) -> Result<PathBuf, String> {
    let dest_path = PathBuf::from(value);
    if !dest_path.is_absolute() {
        return Err("Download destination must be absolute".to_string());
    }
    if dest_path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Download destination must not contain parent directory traversal".to_string());
    }

    let root = models_root_for_path(&dest_path)?;
    let mut relative = dest_path
        .strip_prefix(&root)
        .map_err(|_| "Download destination must live under the model cache".to_string())?
        .components();
    let runtime = relative
        .next()
        .and_then(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .ok_or_else(|| "Download destination must include a runtime directory".to_string())?;
    let allowed = [
        "llama-cpp",
        "sd-cpp",
        "mlx",
        "ollama",
        "lm-studio",
        "comfyui",
    ];
    if !allowed.contains(&runtime) {
        return Err("Download destination runtime is not allowed".to_string());
    }
    if dest_path.file_name().is_none() {
        return Err("Download destination must point to a file".to_string());
    }
    Ok(dest_path)
}

/// Core async download task — streams response body to a `.part` file with
/// resume support (Range header), optional SHA-256 verification, and cancel.
struct DownloadTask {
    url: String,
    dest: String,
    part_path: PathBuf,
    sha256: Option<String>,
    job_id: String,
    state: Arc<DownloadState>,
    tx: tokio::sync::broadcast::Sender<JobSnapshot>,
    cancel: Arc<DownloadCancel>,
    timeouts: DownloadTimeouts,
    secure_target: SecureDownloadTarget,
    #[cfg(test)]
    hash_test_hook: Option<Arc<HashReadTestHook>>,
}

#[cfg(test)]
struct HashReadTestHook {
    first_chunk: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}

#[cfg(test)]
impl HashReadTestHook {
    fn new() -> Self {
        Self {
            first_chunk: tokio::sync::Notify::new(),
            resume: tokio::sync::Notify::new(),
        }
    }

    async fn pause_after_first_chunk(&self) {
        self.first_chunk.notify_one();
        self.resume.notified().await;
    }
}

async fn mark_download_canceled(
    state: &Arc<DownloadState>,
    job_id: &str,
    tx: &tokio::sync::broadcast::Sender<JobSnapshot>,
    received: u64,
    total: u64,
) {
    update_job_status(state, job_id, tx, "canceled", received, total, None);
}

async fn run_download_task(task: DownloadTask) {
    let DownloadTask {
        url,
        dest: _dest,
        part_path,
        sha256,
        job_id,
        state,
        tx,
        cancel,
        timeouts,
        secure_target,
        #[cfg(test)]
        hash_test_hook,
    } = task;
    if cancel.is_canceled() {
        mark_download_canceled(&state, &job_id, &tx, 0, 0).await;
        return;
    }
    let existing_destination = match secure_target.open_destination_read() {
        Ok(file) => file,
        Err(error) => {
            set_job_error(
                &state,
                &job_id,
                &tx,
                &format!("Could not securely open destination: {error}"),
            );
            return;
        }
    };
    if let Some(mut existing_dest_file) = existing_destination {
        let existing_dest_bytes = existing_dest_file
            .metadata()
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let linked_etag = if sha256.is_none() {
            match fetch_hf_linked_etag(&url, &cancel, timeouts).await {
                Ok(value) => value,
                Err(AuxiliaryHeadError::Canceled) => {
                    mark_download_canceled(
                        &state,
                        &job_id,
                        &tx,
                        existing_dest_bytes,
                        existing_dest_bytes,
                    )
                    .await;
                    return;
                }
                Err(AuxiliaryHeadError::Request(_) | AuxiliaryHeadError::TimedOut) => None,
            }
        } else {
            None
        };
        if sha256.is_none() && linked_etag.is_none() {
            set_job_error(
                &state,
                &job_id,
                &tx,
                "Existing model file cannot be trusted because no SHA-256 or HF x-linked-etag is available.",
            );
            return;
        }
        match sha256_reader_cancellable(
            &mut existing_dest_file,
            &cancel,
            timeouts.read_idle,
            #[cfg(test)]
            hash_test_hook.as_deref(),
        )
        .await
        {
            Ok(actual) => {
                if cancel.is_canceled() {
                    mark_download_canceled(
                        &state,
                        &job_id,
                        &tx,
                        existing_dest_bytes,
                        existing_dest_bytes,
                    )
                    .await;
                    return;
                }
                match compare_download_hashes(&actual, sha256.as_deref(), linked_etag.as_deref()) {
                    Ok(()) => {
                        update_job_status(
                            &state,
                            &job_id,
                            &tx,
                            "ready",
                            existing_dest_bytes,
                            existing_dest_bytes,
                            None,
                        );
                        return;
                    }
                    Err(message) => {
                        drop(existing_dest_file);
                        let message = cleanup_failed_destination(
                            &secure_target,
                            &message,
                            "Untrusted destination file",
                        )
                        .await;
                        set_job_error(&state, &job_id, &tx, &message);
                        return;
                    }
                }
            }
            Err(err) if cancel.is_canceled() || err.kind() == std::io::ErrorKind::Interrupted => {
                mark_download_canceled(
                    &state,
                    &job_id,
                    &tx,
                    existing_dest_bytes,
                    existing_dest_bytes,
                )
                .await;
                return;
            }
            Err(err) => {
                set_job_error(
                    &state,
                    &job_id,
                    &tx,
                    &format!("Could not verify existing file: {err}"),
                );
                return;
            }
        }
    }

    // Determine how many bytes we already have (resume).
    let existing_bytes = match secure_target.part_len() {
        Ok(bytes) => bytes,
        Err(error) => {
            set_job_error(
                &state,
                &job_id,
                &tx,
                &format!("Could not securely inspect part file: {error}"),
            );
            return;
        }
    };

    // Build the HTTP request with optional Range header.
    // E6: Use the process-wide shared client (connection-pool reuse across concurrent
    // downloads). Falls back to inline build on first-init race; error path unchanged.
    let client = match get_http_client_with_connect_timeout(timeouts.connect) {
        Ok(c) => c,
        Err(err) => {
            set_job_error(&state, &job_id, &tx, &format!("HTTP client error: {err}"));
            return;
        }
    };

    let mut request = client.get(&url);
    if existing_bytes > 0 {
        request = request.header("Range", format!("bytes={existing_bytes}-"));
    }

    let response = match race_cancel_timeout(&cancel, timeouts.headers, request.send()).await {
        WaitOutcome::Ready(Ok(r)) => r,
        WaitOutcome::Ready(Err(err)) => {
            set_job_error(&state, &job_id, &tx, &format!("Request failed: {err}"));
            return;
        }
        WaitOutcome::Canceled => {
            mark_download_canceled(&state, &job_id, &tx, existing_bytes, 0).await;
            return;
        }
        WaitOutcome::TimedOut => {
            set_job_error(
                &state,
                &job_id,
                &tx,
                "Timed out waiting for download response headers.",
            );
            return;
        }
    };

    if response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && existing_bytes > 0 {
        let mut remote_total = response
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .and_then(parse_content_range_total);
        let mut linked_etag = linked_etag_from_headers(response.headers());

        if remote_total.is_none() || linked_etag.is_none() {
            match fetch_remote_download_metadata(&client, &url, &cancel, timeouts).await {
                Ok(metadata) => {
                    if remote_total.is_none() {
                        remote_total = metadata.total;
                    }
                    if linked_etag.is_none() {
                        linked_etag = metadata.linked_etag;
                    }
                }
                Err(AuxiliaryHeadError::Canceled) => {
                    mark_download_canceled(&state, &job_id, &tx, existing_bytes, 0).await;
                    return;
                }
                Err(err) if remote_total.is_none() => {
                    set_job_error(
                        &state,
                        &job_id,
                        &tx,
                        &format!(
                            "Server rejected resume and remote size could not be verified: {err}"
                        ),
                    );
                    return;
                }
                Err(_) => {}
            }
        }

        let Some(remote_total) = remote_total else {
            set_job_error(
                &state,
                &job_id,
                &tx,
                "Server rejected resume and did not provide a remote file size.",
            );
            return;
        };

        match classify_partial_download(existing_bytes, remote_total) {
            PartialDownloadState::Complete => {
                if sha256.is_none() && linked_etag.is_none() {
                    set_job_error(
                        &state,
                        &job_id,
                        &tx,
                        "Completed partial file could not be finalized because no SHA-256 or HF x-linked-etag was available for verification.",
                    );
                    return;
                }
                let actual = match sha256_secure_part_cancellable(
                    &secure_target,
                    &cancel,
                    timeouts.read_idle,
                    #[cfg(test)]
                    hash_test_hook.as_deref(),
                )
                .await
                {
                    Ok(digest) => digest,
                    Err(err)
                        if cancel.is_canceled()
                            || err.kind() == std::io::ErrorKind::Interrupted =>
                    {
                        mark_download_canceled(&state, &job_id, &tx, existing_bytes, remote_total)
                            .await;
                        return;
                    }
                    Err(err) => {
                        let primary = format!("Could not verify completed partial download: {err}");
                        let message =
                            cleanup_failed_part(&secure_target, &primary, "Part file").await;
                        set_job_error(&state, &job_id, &tx, &message);
                        return;
                    }
                };
                if cancel.is_canceled() {
                    mark_download_canceled(&state, &job_id, &tx, existing_bytes, remote_total)
                        .await;
                    return;
                }
                if let Err(message) =
                    compare_download_hashes(&actual, sha256.as_deref(), linked_etag.as_deref())
                {
                    let message = cleanup_failed_part(&secure_target, &message, "Part file").await;
                    set_job_error(&state, &job_id, &tx, &message);
                    return;
                }
                if matches!(
                    finalize_decision_before_rename(cancel.is_canceled()),
                    FinalizeDecision::CancelKeepPart
                ) {
                    mark_download_canceled(&state, &job_id, &tx, existing_bytes, remote_total)
                        .await;
                    return;
                }
                if let Err(err) = secure_target.rename_part_to_destination() {
                    if matches!(
                        finalize_decision_before_rename(cancel.is_canceled()),
                        FinalizeDecision::CancelKeepPart
                    ) {
                        mark_download_canceled(&state, &job_id, &tx, existing_bytes, remote_total)
                            .await;
                        return;
                    }
                    set_job_error(
                        &state,
                        &job_id,
                        &tx,
                        &format!("Could not finalize file: {err}"),
                    );
                    return;
                }
                match finalize_decision_after_rename(cancel.is_canceled()) {
                    FinalizeDecision::CancelKeepDest => {
                        // Rename succeeded under cancel: keep verified dest, never ready.
                        mark_download_canceled(&state, &job_id, &tx, existing_bytes, remote_total)
                            .await;
                    }
                    FinalizeDecision::MarkReady => {
                        update_job_status(
                            &state,
                            &job_id,
                            &tx,
                            "ready",
                            existing_bytes,
                            remote_total,
                            None,
                        );
                    }
                    FinalizeDecision::CancelKeepPart | FinalizeDecision::ProceedRename => {
                        mark_download_canceled(&state, &job_id, &tx, existing_bytes, remote_total)
                            .await;
                    }
                }
                return;
            }
            PartialDownloadState::Oversized => {
                let primary = format!(
                    "Partial download is larger than the remote file ({existing_bytes} > {remote_total})"
                );
                let message = cleanup_failed_part(&secure_target, &primary, "Part file").await;
                set_job_error(&state, &job_id, &tx, &message);
                return;
            }
            PartialDownloadState::Incomplete => {
                set_job_error(
                    &state,
                    &job_id,
                    &tx,
                    "Server rejected the resume range before the partial file was complete. Retry the download.",
                );
                return;
            }
        }
    }

    if !response.status().is_success() {
        set_job_error(
            &state,
            &job_id,
            &tx,
            &format!("Server returned HTTP {}", response.status()),
        );
        return;
    }

    // HuggingFace LFS/Xet resolve URLs expose `X-Linked-ETag: "<sha256>"` on
    // the resolve response. The redirected object `ETag` is not guaranteed to
    // be the file SHA, so only trust x-linked-etag as the live digest source.
    let mut linked_etag = linked_etag_from_headers(response.headers());
    if linked_etag.is_none() && sha256.is_none() {
        match fetch_hf_linked_etag(&url, &cancel, timeouts).await {
            Ok(value) => linked_etag = value,
            Err(AuxiliaryHeadError::Canceled) => {
                mark_download_canceled(&state, &job_id, &tx, existing_bytes, 0).await;
                return;
            }
            Err(AuxiliaryHeadError::Request(_) | AuxiliaryHeadError::TimedOut) => {}
        }
    }
    if sha256.is_none() && linked_etag.is_none() {
        set_job_error(
            &state,
            &job_id,
            &tx,
            "Download cannot be verified because no SHA-256 or HF x-linked-etag is available.",
        );
        return;
    }

    // Determine whether this is a genuine resume (206) or a full-body response (200).
    // If we sent a Range header but the server responded 200 (ignored Range), we must
    // truncate the .part file and restart — otherwise the full body would be appended
    // onto existing partial bytes, producing a corrupted oversized file.
    let is_resume = existing_bytes > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;

    // Derive total from Content-Length.
    // For 206 (true resume): total = Content-Length (remaining) + already-downloaded bytes.
    // For 200 (fresh or Range-ignored): total = Content-Length only.
    let content_length = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let total = if content_length > 0 {
        if is_resume {
            content_length + existing_bytes
        } else {
            content_length
        }
    } else {
        0
    };

    // Real disk-space check now that the actual model size is known: the bytes
    // still to be written must fit on the dest volume with a safety margin.
    // Failing here (before streaming) beats hitting ENOSPC mid-download.
    if content_length > 0 {
        const DISK_MARGIN_BYTES: u64 = 512 * 1024 * 1024;
        let parent = part_path.parent().unwrap_or(&part_path);
        if let Some(available) = available_disk_bytes(parent) {
            if available < content_length.saturating_add(DISK_MARGIN_BYTES) {
                let need_gb = content_length as f64 / 1_073_741_824.0;
                let have_gb = available as f64 / 1_073_741_824.0;
                set_job_error(
                    &state,
                    &job_id,
                    &tx,
                    &format!(
                        "Insufficient disk space: download needs {need_gb:.1} GiB but only {have_gb:.1} GiB is available. Free up space and retry."
                    ),
                );
                return;
            }
        }
    }

    // Open the .part file:
    //   - 206 genuine resume  → append mode, received starts at existing_bytes
    //   - 200 (fresh or Range-ignored) → create+truncate, received starts at 0
    let (mut file, received_start) = if is_resume {
        let f = match secure_target.open_part(true) {
            Ok(f) => f,
            Err(err) => {
                set_job_error(
                    &state,
                    &job_id,
                    &tx,
                    &format!("Could not open part file: {err}"),
                );
                return;
            }
        };
        (f, existing_bytes)
    } else {
        // Either a fresh download or the server ignored our Range header and sent 200.
        // Truncate any stale .part so we start clean.
        let f = match secure_target.open_part(false) {
            Ok(f) => f,
            Err(err) => {
                set_job_error(
                    &state,
                    &job_id,
                    &tx,
                    &format!("Could not open part file: {err}"),
                );
                return;
            }
        };
        (f, 0u64)
    };

    // Transition to downloading.
    update_job_status(
        &state,
        &job_id,
        &tx,
        "downloading",
        received_start,
        total,
        None,
    );

    let mut received = received_start;
    let mut last_tick = Instant::now();
    // Streaming SHA-256 hasher — an optimization for fresh (non-resumed)
    // downloads where every byte passes through this loop. For a 206 resume the
    // already-downloaded bytes live on disk and never reach the stream, so the
    // streaming hash would be incomplete; in that case we leave the hasher
    // `None` and instead re-hash the complete `.part` file from disk after the
    // stream finishes (see the verification block below). Either way, when an
    // expected hash (static catalog sha256 OR live HF linked-etag) is supplied
    // the file is verified before it is trusted.
    let need_hash = sha256.is_some() || linked_etag.is_some();
    let mut hasher: Option<Sha256> = if need_hash && !is_resume {
        Some(Sha256::new())
    } else {
        None
    };

    let mut stream = response.bytes_stream();

    loop {
        if cancel.is_canceled() {
            if let Err(err) = await_managed_file_io(file.flush()).await {
                let primary = format!("Could not preserve canceled partial download: {err}");
                drop(file);
                let message = cleanup_failed_part(&secure_target, &primary, "Part file").await;
                set_job_error(&state, &job_id, &tx, &message);
                return;
            }
            mark_download_canceled(&state, &job_id, &tx, received, total).await;
            // Leave the .part file in place for future resume.
            return;
        }

        let next = race_cancel_timeout(&cancel, timeouts.read_idle, stream.next()).await;
        match next {
            WaitOutcome::Canceled => {
                if let Err(err) = await_managed_file_io(file.flush()).await {
                    let primary = format!("Could not preserve canceled partial download: {err}");
                    drop(file);
                    let message = cleanup_failed_part(&secure_target, &primary, "Part file").await;
                    set_job_error(&state, &job_id, &tx, &message);
                    return;
                }
                mark_download_canceled(&state, &job_id, &tx, received, total).await;
                return;
            }
            WaitOutcome::TimedOut => {
                if let Err(flush_err) = await_managed_file_io(file.flush()).await {
                    let primary = format!(
                        "Read idle timeout. Partial download could not be preserved: {flush_err}"
                    );
                    drop(file);
                    let message = cleanup_failed_part(&secure_target, &primary, "Part file").await;
                    set_job_error(&state, &job_id, &tx, &message);
                    return;
                }
                update_job_status(
                    &state,
                    &job_id,
                    &tx,
                    "error",
                    received,
                    total,
                    Some("Read idle timeout. Partial download kept for retry.".to_string()),
                );
                return;
            }
            WaitOutcome::Ready(Some(Ok(chunk))) => {
                if let Err(err) = file.write_all(chunk.as_ref()).await {
                    let primary = format!("Write error: {err}");
                    drop(file);
                    let message = cleanup_failed_part(&secure_target, &primary, "Part file").await;
                    set_job_error(&state, &job_id, &tx, &message);
                    return;
                }
                received += chunk.len() as u64;
                if let Some(ref mut h) = hasher {
                    h.update(chunk.as_ref());
                }
                if last_tick.elapsed() >= Duration::from_millis(250) {
                    update_job_status(&state, &job_id, &tx, "downloading", received, total, None);
                    last_tick = Instant::now();
                }
            }
            WaitOutcome::Ready(Some(Err(ref err))) => {
                if let Err(flush_err) = await_managed_file_io(file.flush()).await {
                    let primary = format!(
                        "Stream error: {err}. Partial download could not be preserved: {flush_err}"
                    );
                    drop(file);
                    let message = cleanup_failed_part(&secure_target, &primary, "Part file").await;
                    set_job_error(&state, &job_id, &tx, &message);
                    return;
                }
                update_job_status(
                    &state,
                    &job_id,
                    &tx,
                    "error",
                    received,
                    total,
                    Some(format!(
                        "Stream error: {err}. Partial download kept for retry."
                    )),
                );
                return;
            }
            WaitOutcome::Ready(None) => break,
        }
    }

    // File-system flush is not reliably cancelable in-process. Keep it owned
    // by the registered task until the syscall really completes; shutdown is
    // fully drained rather than reporting a false hard deadline.
    match await_managed_file_io(file.flush()).await {
        Err(err) => {
            let primary = format!("Flush error: {err}");
            drop(file);
            let message = cleanup_failed_part(&secure_target, &primary, "Part file").await;
            set_job_error(&state, &job_id, &tx, &message);
            return;
        }
        Ok(()) => {
            drop(file);
        }
    }

    if cancel.is_canceled() {
        mark_download_canceled(&state, &job_id, &tx, received, total).await;
        return;
    }

    if matches!(
        finalize_decision_before_rename(cancel.is_canceled()),
        FinalizeDecision::CancelKeepPart
    ) {
        mark_download_canceled(&state, &job_id, &tx, received, total).await;
        return;
    }

    // SHA-256 verification. When the catalog supplies an expected digest, OR
    // the HF response carried an x-linked-etag, the complete file must be
    // verified before it is renamed into place and marked ready — including
    // resumed downloads, whose `.part` bytes could have been corrupted or
    // tampered with on disk between sessions. Fresh downloads reuse the
    // streaming hash computed in the loop; resumed downloads (no streaming
    // hasher) are re-hashed from disk here.
    if need_hash {
        let actual = match hasher {
            Some(hasher) => {
                let result = hasher.finalize();
                result
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            }
            None => {
                match sha256_secure_part_cancellable(
                    &secure_target,
                    &cancel,
                    timeouts.read_idle,
                    #[cfg(test)]
                    hash_test_hook.as_deref(),
                )
                .await
                {
                    Ok(digest) => digest,
                    Err(err)
                        if cancel.is_canceled()
                            || err.kind() == std::io::ErrorKind::Interrupted =>
                    {
                        mark_download_canceled(&state, &job_id, &tx, received, total).await;
                        return;
                    }
                    Err(err) => {
                        let primary = format!("Could not verify download integrity: {err}");
                        let message =
                            cleanup_failed_part(&secure_target, &primary, "Part file").await;
                        set_job_error(&state, &job_id, &tx, &message);
                        return;
                    }
                }
            }
        };
        if matches!(
            finalize_decision_before_rename(cancel.is_canceled()),
            FinalizeDecision::CancelKeepPart
        ) {
            mark_download_canceled(&state, &job_id, &tx, received, total).await;
            return;
        }
        if let Err(message) =
            compare_download_hashes(&actual, sha256.as_deref(), linked_etag.as_deref())
        {
            let message = cleanup_failed_part(&secure_target, &message, "Part file").await;
            set_job_error(&state, &job_id, &tx, &message);
            return;
        }
    }

    if matches!(
        finalize_decision_before_rename(cancel.is_canceled()),
        FinalizeDecision::CancelKeepPart
    ) {
        // Cancellation before rename: preserve `.part` for resume; never ready.
        mark_download_canceled(&state, &job_id, &tx, received, total).await;
        return;
    }

    // Rename .part → dest. Once the OS rename begins it cannot be preempted;
    // cancel observed afterwards keeps the verified destination but the job
    // remains canceled and can never transition to ready.
    if let Err(err) = secure_target.rename_part_to_destination() {
        if matches!(
            finalize_decision_before_rename(cancel.is_canceled()),
            FinalizeDecision::CancelKeepPart
        ) {
            mark_download_canceled(&state, &job_id, &tx, received, total).await;
            return;
        }
        set_job_error(
            &state,
            &job_id,
            &tx,
            &format!("Could not finalize file: {err}"),
        );
        return;
    }
    match finalize_decision_after_rename(cancel.is_canceled()) {
        FinalizeDecision::CancelKeepDest => {
            mark_download_canceled(&state, &job_id, &tx, received, total).await;
        }
        FinalizeDecision::MarkReady => {
            update_job_status(&state, &job_id, &tx, "ready", received, total, None);
        }
        FinalizeDecision::CancelKeepPart | FinalizeDecision::ProceedRename => {
            // Unreachable after a successful rename.
            mark_download_canceled(&state, &job_id, &tx, received, total).await;
        }
    }
}

/// Compute the SHA-256 of a file by streaming it from disk in 1 MiB chunks.
/// Used to verify resumed downloads, where the already-downloaded bytes never
/// pass through the in-memory streaming hasher.
#[cfg(test)]
async fn sha256_file_from_disk(path: &std::path::Path) -> Result<String, std::io::Error> {
    sha256_file_from_disk_cancellable(
        path,
        &DownloadCancel::new(),
        Duration::from_secs(3600),
        None,
    )
    .await
}

async fn sha256_secure_part_cancellable(
    target: &SecureDownloadTarget,
    cancel: &DownloadCancel,
    read_idle: Duration,
    #[cfg(test)] test_hook: Option<&HashReadTestHook>,
) -> Result<String, std::io::Error> {
    let mut file = target.open_part_read()?;
    sha256_reader_cancellable(
        &mut file,
        cancel,
        read_idle,
        #[cfg(test)]
        test_hook,
    )
    .await
}

#[cfg(test)]
async fn sha256_file_from_disk_cancellable(
    path: &std::path::Path,
    cancel: &DownloadCancel,
    read_idle: Duration,
    #[cfg(test)] test_hook: Option<&HashReadTestHook>,
) -> Result<String, std::io::Error> {
    let mut file = tokio::fs::File::open(path).await?;
    sha256_reader_cancellable(
        &mut file,
        cancel,
        read_idle,
        #[cfg(test)]
        test_hook,
    )
    .await
}

async fn sha256_reader_cancellable<R>(
    reader: &mut R,
    cancel: &DownloadCancel,
    read_idle: Duration,
    #[cfg(test)] mut test_hook: Option<&HashReadTestHook>,
) -> Result<String, std::io::Error>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        if cancel.is_canceled() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "download canceled during hashing",
            ));
        }
        let read = match race_cancel_timeout(cancel, read_idle, reader.read(&mut buf)).await {
            WaitOutcome::Ready(Ok(n)) => n,
            WaitOutcome::Ready(Err(err)) => return Err(err),
            WaitOutcome::Canceled => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "download canceled during hashing",
                ))
            }
            WaitOutcome::TimedOut => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "read idle timeout during hashing",
                ))
            }
        };
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        #[cfg(test)]
        if let Some(hook) = test_hook.take() {
            hook.pause_after_first_chunk().await;
        }
    }
    let result = hasher.finalize();
    Ok(result
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>())
}

#[derive(Debug, PartialEq, Eq)]
enum PartialDownloadState {
    Complete,
    Oversized,
    Incomplete,
}

struct RemoteDownloadMetadata {
    total: Option<u64>,
    linked_etag: Option<String>,
}

#[derive(Debug)]
enum AuxiliaryHeadError {
    Request(reqwest::Error),
    Canceled,
    TimedOut,
}

impl std::fmt::Display for AuxiliaryHeadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Request(error) => write!(formatter, "{error}"),
            Self::Canceled => formatter.write_str("download canceled during metadata request"),
            Self::TimedOut => formatter.write_str("metadata request timed out"),
        }
    }
}

fn parse_content_range_total(value: &str) -> Option<u64> {
    let (_, total) = value.trim().split_once('/')?;
    let total = total.trim();
    if total == "*" {
        return None;
    }
    total.parse::<u64>().ok()
}

fn classify_partial_download(existing_bytes: u64, remote_total: u64) -> PartialDownloadState {
    match existing_bytes.cmp(&remote_total) {
        std::cmp::Ordering::Equal => PartialDownloadState::Complete,
        std::cmp::Ordering::Greater => PartialDownloadState::Oversized,
        std::cmp::Ordering::Less => PartialDownloadState::Incomplete,
    }
}

fn linked_etag_from_headers(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get("x-linked-etag")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().trim_matches('"').to_ascii_lowercase())
        .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
}

fn content_length_from_headers(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
}

async fn fetch_remote_download_metadata(
    client: &reqwest::Client,
    url: &str,
    cancel: &DownloadCancel,
    timeouts: DownloadTimeouts,
) -> Result<RemoteDownloadMetadata, AuxiliaryHeadError> {
    let response = send_auxiliary_head(client, url, cancel, timeouts.headers).await?;
    let mut linked_etag = linked_etag_from_headers(response.headers());
    if linked_etag.is_none() {
        linked_etag = fetch_hf_linked_etag(url, cancel, timeouts).await?;
    }
    Ok(RemoteDownloadMetadata {
        total: content_length_from_headers(response.headers()),
        linked_etag,
    })
}

async fn send_auxiliary_head(
    client: &reqwest::Client,
    url: &str,
    cancel: &DownloadCancel,
    timeout: Duration,
) -> Result<reqwest::Response, AuxiliaryHeadError> {
    match race_cancel_timeout(cancel, timeout, client.head(url).timeout(timeout).send()).await {
        WaitOutcome::Ready(Ok(response)) => Ok(response),
        WaitOutcome::Ready(Err(error)) => Err(AuxiliaryHeadError::Request(error)),
        WaitOutcome::Canceled => Err(AuxiliaryHeadError::Canceled),
        WaitOutcome::TimedOut => Err(AuxiliaryHeadError::TimedOut),
    }
}

fn hf_metadata_client(timeouts: DownloadTimeouts) -> Result<reqwest::Client, reqwest::Error> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if timeouts.connect == DownloadTimeouts::default().connect
        && timeouts.headers == DownloadTimeouts::default().headers
    {
        if let Some(client) = CLIENT.get() {
            return Ok(client.clone());
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("Lunery Lab Desktop/1.0")
            .connect_timeout(timeouts.connect)
            .timeout(timeouts.headers)
            .build()?;
        let _ = CLIENT.set(client);
        return Ok(CLIENT.get().expect("metadata OnceLock set above").clone());
    }
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Lunery Lab Desktop/1.0")
        .connect_timeout(timeouts.connect)
        .timeout(timeouts.headers)
        .build()
}

async fn fetch_hf_linked_etag(
    url: &str,
    cancel: &DownloadCancel,
    timeouts: DownloadTimeouts,
) -> Result<Option<String>, AuxiliaryHeadError> {
    let client = hf_metadata_client(timeouts).map_err(AuxiliaryHeadError::Request)?;
    let response = send_auxiliary_head(&client, url, cancel, timeouts.headers).await?;
    Ok(linked_etag_from_headers(response.headers()))
}

#[cfg(test)]
pub(crate) async fn auxiliary_head_for_shutdown_test(
    url: &str,
    cancel: &DownloadCancel,
) -> Result<(), String> {
    fetch_hf_linked_etag(url, cancel, DownloadTimeouts::default())
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn compare_download_hashes(
    actual: &str,
    sha256: Option<&str>,
    linked_etag: Option<&str>,
) -> Result<(), String> {
    if sha256.is_none() && linked_etag.is_none() {
        return Err(
            "Download cannot be verified because no SHA-256 or HF x-linked-etag is available"
                .to_string(),
        );
    }
    if let Some(expected) = sha256 {
        let expected_lc = expected.to_ascii_lowercase();
        if actual != expected_lc {
            return Err(format!(
                "SHA-256 mismatch: expected {expected_lc}, got {actual}"
            ));
        }
    }
    if let Some(live_etag) = linked_etag {
        if actual != live_etag {
            return Err(format!(
                "SHA-256 mismatch against HF x-linked-etag: expected {live_etag}, got {actual}"
            ));
        }
    }
    Ok(())
}

fn cleanup_result_message(
    primary: &str,
    label: &str,
    result: Result<(), std::io::Error>,
) -> String {
    match result {
        Ok(()) => format!("{primary}. {label} removed."),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            format!("{primary}. {label} was already absent.")
        }
        Err(error) => format!("{primary}. Could not remove {label}: {error}"),
    }
}

async fn cleanup_failed_part(target: &SecureDownloadTarget, primary: &str, label: &str) -> String {
    cleanup_result_message(primary, label, target.unlink_part())
}

async fn cleanup_failed_destination(
    target: &SecureDownloadTarget,
    primary: &str,
    label: &str,
) -> String {
    cleanup_result_message(primary, label, target.unlink_destination())
}

/// Terminal status transitions are monotonic. Once a job is ready/error/canceled
/// it never leaves that state, and canceled can never become ready.
pub(crate) fn can_commit_download_status(current: &str, next: &str) -> bool {
    if current == next {
        return true;
    }
    if is_terminal_download_status(current) {
        return false;
    }
    if current == "canceled" && next == "ready" {
        return false;
    }
    true
}

pub(crate) fn update_job_status(
    state: &Arc<DownloadState>,
    job_id: &str,
    tx: &tokio::sync::broadcast::Sender<JobSnapshot>,
    status: &str,
    received: u64,
    total: u64,
    error: Option<String>,
) {
    let committed = if let Ok(mut guard) = state.0.lock() {
        if let Some(job) = guard.get_mut(job_id) {
            if !can_commit_download_status(&job.status, status) {
                None
            } else if job.cancel.is_canceled() && !is_terminal_download_status(status) {
                // Ignore late progress after an accepted cancel. The worker
                // still owns the destination until it reaches a real terminal
                // branch and commits canceled below.
                None
            } else {
                let cancel_wins = job.cancel.is_canceled()
                    && matches!(status, "ready" | "error")
                    && !is_terminal_download_status(&job.status);
                let committed_status = if cancel_wins { "canceled" } else { status };
                job.status = committed_status.to_string();
                job.received = received;
                job.total = total;
                job.error = if cancel_wins { None } else { error };
                if is_terminal_download_status(committed_status) {
                    job.owns_destination = false;
                    job.finished_at = Some(Instant::now());
                }
                Some(job.snapshot())
            }
        } else {
            None
        }
    } else {
        None
    };
    // Broadcast only committed snapshots.
    if let Some(snapshot) = committed {
        let _ = tx.send(snapshot);
    }
}

pub(crate) fn set_job_error(
    state: &Arc<DownloadState>,
    job_id: &str,
    tx: &tokio::sync::broadcast::Sender<JobSnapshot>,
    message: &str,
) {
    update_job_status(state, job_id, tx, "error", 0, 0, Some(message.to_string()));
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::SecureFileIdentity;
    use super::{
        await_managed_file_io, can_commit_download_status, classify_partial_download,
        cleanup_result_message, compare_download_hashes, ensure_secure_download_mutation_platform,
        fetch_remote_download_metadata, finalize_decision_after_rename,
        finalize_decision_before_rename, hf_download_start_inner_for_platform, is_canonical_uuid,
        linked_etag_from_headers, parse_content_range_total, reserve_download_job,
        run_download_task, sha256_file_from_disk, sha256_reader_cancellable, update_job_status,
        validate_hf_download_dest, AuxiliaryHeadError, DownloadCancel, DownloadCancelRequest,
        DownloadJob, DownloadRequestIdentity, DownloadReservation, DownloadState, DownloadTask,
        DownloadTimeouts, FinalizeDecision, HashReadTestHook, PartialDownloadState,
        SecureDownloadTarget, MAX_TERMINAL_HISTORY,
    };
    use crate::test_global_lock;
    use reqwest::header::{HeaderMap, HeaderValue};
    use sha2::{Digest, Sha256};
    use std::ffi::OsString;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::pin::Pin;
    use std::sync::{Arc, Barrier};
    use std::task::{Context, Poll};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncRead, ReadBuf};
    use tokio::sync::oneshot;

    struct OneChunkThenPending {
        emitted: bool,
        first_chunk: Option<oneshot::Sender<()>>,
    }

    impl AsyncRead for OneChunkThenPending {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if !self.emitted {
                self.emitted = true;
                buf.put_slice(b"first hash chunk");
                if let Some(first_chunk) = self.first_chunk.take() {
                    let _ = first_chunk.send(());
                }
                return Poll::Ready(Ok(()));
            }
            Poll::Pending
        }
    }

    fn unique_test_path(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        std::env::temp_dir().join(format!("lunerylab-{name}-{nonce}"))
    }

    fn secure_target_for_test(destination: &std::path::Path) -> SecureDownloadTarget {
        let parent = destination.parent().expect("test destination parent");
        std::fs::create_dir_all(parent).expect("create test destination parent");
        let root = parent.canonicalize().expect("canonical test parent");
        let destination = root.join(destination.file_name().expect("test destination name"));
        SecureDownloadTarget::pin_in_root(root, destination).expect("pin test destination")
    }

    fn restore_env(name: &str, value: Option<OsString>) {
        if let Some(value) = value {
            std::env::set_var(name, value);
        } else {
            std::env::remove_var(name);
        }
    }

    #[test]
    fn destination_delete_lease_closes_the_download_start_race() {
        let state = DownloadState::default();
        let destination = unique_test_path("leased-download.gguf");
        state
            .acquire_destination_delete_lease(destination.clone(), "delete-lease")
            .expect("acquire delete lease");
        let (tx, _) = tokio::sync::broadcast::channel(4);

        assert!(state
            .reserve_job(
                "blocked-job",
                destination.clone(),
                Arc::new(DownloadCancel::new()),
                tx.clone(),
            )
            .is_err());

        state.release_destination_delete_lease(&destination, "delete-lease");
        state
            .reserve_job(
                "allowed-job",
                destination,
                Arc::new(DownloadCancel::new()),
                tx,
            )
            .expect("released lease allows a new download");
    }

    #[test]
    fn same_id_renewal_blocks_download_start_past_original_expiry() {
        let state = DownloadState::default();
        let destination = unique_test_path("renewed-download.gguf");
        let t0 = Instant::now();
        state
            .acquire_destination_delete_lease_at(destination.clone(), "renew", t0)
            .expect("initial lease");
        state
            .acquire_destination_delete_lease_at(
                destination.clone(),
                "renew",
                t0 + Duration::from_secs(59),
            )
            .expect("same-id renewal");
        let (tx, _) = tokio::sync::broadcast::channel(4);
        assert!(state
            .reserve_job_at(
                "blocked-after-original-expiry",
                destination.clone(),
                Arc::new(DownloadCancel::new()),
                tx.clone(),
                t0 + Duration::from_secs(61),
            )
            .is_err());
        assert!(state
            .acquire_destination_delete_lease_at(
                destination,
                "different-owner",
                t0 + Duration::from_secs(61),
            )
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn pinned_parent_blocks_intermediate_directory_symlink_swap() {
        use rustix::fs::OFlags;

        let root = unique_test_path("pinned-parent-root");
        let original_parent = root.join("nested");
        let moved_parent = root.join("pinned-original");
        let outside = unique_test_path("pinned-parent-outside");
        std::fs::create_dir_all(&original_parent).expect("create model directory");
        std::fs::create_dir_all(&outside).expect("create outside directory");
        let canonical_root = root.canonicalize().expect("canonical model root");
        let destination = canonical_root.join("nested/model.gguf");
        let target = SecureDownloadTarget::pin_in_root(canonical_root, destination)
            .expect("pin nested parent");
        let release = Arc::new(Barrier::new(2));
        let release_w = Arc::clone(&release);
        let worker = std::thread::spawn(move || {
            release_w.wait();
            let mut file = target
                .open_at(
                    &target.part_name,
                    OFlags::WRONLY | OFlags::CREATE | OFlags::TRUNC,
                )
                .expect("open through pinned directory descriptor");
            file.write_all(b"pinned").expect("write pinned part");
        });

        std::fs::rename(&original_parent, &moved_parent).expect("move original directory");
        std::os::unix::fs::symlink(&outside, &original_parent)
            .expect("swap intermediate directory with symlink");
        release.wait();
        worker.join().expect("pinned writer");

        assert_eq!(
            std::fs::read(moved_parent.join("model.gguf.part")).expect("pinned part"),
            b"pinned"
        );
        assert!(!outside.join("model.gguf.part").exists());
        std::fs::remove_dir_all(&root).expect("remove model fixture");
        std::fs::remove_dir_all(&outside).expect("remove outside fixture");
    }

    #[cfg(unix)]
    #[test]
    fn nofollow_part_open_and_rename_reject_symlink_swap() {
        let root = unique_test_path("part-swap-root");
        let outside = unique_test_path("part-swap-outside");
        std::fs::create_dir_all(&root).expect("create model root");
        std::fs::write(&outside, b"outside-sentinel").expect("write outside sentinel");
        let canonical_root = root.canonicalize().expect("canonical model root");
        let destination = canonical_root.join("model.gguf");
        let target = SecureDownloadTarget::pin_in_root(canonical_root, destination)
            .expect("pin destination");
        let part_path = root.join("model.gguf.part");
        let release = Arc::new(Barrier::new(2));
        let release_w = Arc::clone(&release);
        let worker = std::thread::spawn(move || {
            release_w.wait();
            assert!(target.open_part(false).is_err());
            assert!(target.rename_part_to_destination().is_err());
        });

        std::os::unix::fs::symlink(&outside, &part_path).expect("swap part with symlink");
        release.wait();
        worker.join().expect("nofollow worker");

        assert_eq!(
            std::fs::read(&outside).expect("outside sentinel remains"),
            b"outside-sentinel"
        );
        assert!(!root.join("model.gguf").exists());
        std::fs::remove_dir_all(&root).expect("remove model fixture");
        std::fs::remove_file(&outside).expect("remove outside sentinel");
    }

    #[cfg(unix)]
    #[test]
    fn finalization_rejects_regular_file_substitution_after_hash_open() {
        use std::io::Write;

        let root = unique_test_path("part-regular-swap-root");
        std::fs::create_dir_all(&root).expect("create model root");
        let canonical_root = root.canonicalize().expect("canonical model root");
        let destination = canonical_root.join("model.gguf");
        let target = SecureDownloadTarget::pin_in_root(canonical_root, destination.clone())
            .expect("pin destination");
        let part_path = root.join("model.gguf.part");

        let mut original = target
            .open_at(
                &target.part_name,
                rustix::fs::OFlags::RDWR | rustix::fs::OFlags::CREATE | rustix::fs::OFlags::TRUNC,
            )
            .expect("open original part");
        original.write_all(b"verified-a").expect("write original");
        let identity = SecureFileIdentity::from_file(&original).expect("original identity");
        *target.part_identity.lock().expect("identity lock") = Some(identity);
        drop(original);

        let displaced = root.join("displaced-a");
        std::fs::rename(&part_path, &displaced).expect("displace original part");
        std::fs::write(&part_path, b"replacement-b").expect("plant regular replacement");

        let error = target
            .rename_part_to_destination()
            .expect_err("replacement must not be promoted");
        assert!(error.to_string().contains("replaced"));
        assert!(!destination.exists());
        assert_eq!(
            std::fs::read(&part_path).expect("replacement preserved"),
            b"replacement-b"
        );
        assert_eq!(
            std::fs::read(&displaced).expect("original preserved"),
            b"verified-a"
        );
        std::fs::remove_dir_all(&root).expect("remove model fixture");
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_quarantines_but_never_deletes_a_regular_file_replacement() {
        use std::io::Write;

        let root = unique_test_path("cleanup-regular-swap-root");
        std::fs::create_dir_all(&root).expect("create model root");
        let canonical_root = root.canonicalize().expect("canonical model root");
        let target = SecureDownloadTarget::pin_in_root(
            canonical_root.clone(),
            canonical_root.join("model.gguf"),
        )
        .expect("pin destination");
        let part_path = root.join("model.gguf.part");

        let mut original = target
            .open_at(
                &target.part_name,
                rustix::fs::OFlags::RDWR | rustix::fs::OFlags::CREATE | rustix::fs::OFlags::TRUNC,
            )
            .expect("open original part");
        original.write_all(b"verified-a").expect("write original");
        let identity = SecureFileIdentity::from_file(&original).expect("original identity");
        *target.part_identity.lock().expect("identity lock") = Some(identity);
        drop(original);

        std::fs::remove_file(&part_path).expect("remove original name");
        std::fs::write(&part_path, b"replacement-b").expect("plant regular replacement");
        let error = target
            .unlink_part()
            .expect_err("replacement must be reported and preserved");
        assert!(error.to_string().contains("preserved"));
        let quarantined = std::fs::read_dir(&root)
            .expect("list model root")
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains("lunery-quarantine")
            })
            .expect("replacement quarantine");
        assert_eq!(
            std::fs::read(quarantined.path()).expect("replacement preserved"),
            b"replacement-b"
        );
        std::fs::remove_dir_all(&root).expect("remove model fixture");
    }

    #[test]
    fn validates_profile_model_cache_destination() {
        let _guard = test_global_lock();
        let old_home = std::env::var_os("HOME");
        let old_lunery_home = std::env::var_os("LUNERY_HOME");
        let old_lunery_models = std::env::var_os("LUNERY_MODELS_DIR");
        let home = unique_test_path("home");
        let profile = unique_test_path("profile");

        std::env::set_var("HOME", &home);
        std::env::set_var("LUNERY_HOME", &profile);
        std::env::remove_var("LUNERY_MODELS_DIR");

        let profile_dest = profile.join("models").join("llama-cpp").join("model.gguf");
        let outside_dest = home
            .join(".cache")
            .join("lunerylab")
            .join("other")
            .join("llama-cpp")
            .join("model.gguf");

        assert!(validate_hf_download_dest(&profile_dest.to_string_lossy()).is_ok());
        assert!(validate_hf_download_dest(&outside_dest.to_string_lossy()).is_err());

        restore_env("HOME", old_home);
        restore_env("LUNERY_HOME", old_lunery_home);
        restore_env("LUNERY_MODELS_DIR", old_lunery_models);
    }

    #[test]
    fn parses_unsatisfied_range_total() {
        assert_eq!(
            parse_content_range_total("bytes */6688845536"),
            Some(6_688_845_536)
        );
        assert_eq!(
            parse_content_range_total(" bytes  */  22134528992 "),
            Some(22_134_528_992)
        );
    }

    #[test]
    fn rejects_unknown_or_invalid_range_total() {
        assert_eq!(parse_content_range_total("bytes */*"), None);
        assert_eq!(parse_content_range_total("bytes 0-1/abc"), None);
        assert_eq!(parse_content_range_total("not-a-content-range"), None);
    }

    #[test]
    fn classifies_complete_partial_file() {
        assert_eq!(
            classify_partial_download(6_688_845_536, 6_688_845_536),
            PartialDownloadState::Complete
        );
    }

    #[test]
    fn classifies_oversized_partial_file() {
        assert_eq!(
            classify_partial_download(6_688_845_537, 6_688_845_536),
            PartialDownloadState::Oversized
        );
    }

    #[test]
    fn classifies_incomplete_partial_file() {
        assert_eq!(
            classify_partial_download(6_688_845_535, 6_688_845_536),
            PartialDownloadState::Incomplete
        );
    }

    #[test]
    fn linked_etag_ignores_plain_object_etag() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "etag",
            HeaderValue::from_static(
                "\"0ea5ab5cbcddd0d3bae8638c1f03c8639abf96324d199adb1f0a92d7114d7252\"",
            ),
        );

        assert_eq!(linked_etag_from_headers(&headers), None);
    }

    #[test]
    fn linked_etag_accepts_hf_sha_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-linked-etag",
            HeaderValue::from_static(
                "\"b338a7ab5c81600a54be46c4cf950edb3761a52ae163e419beafd250976fb566\"",
            ),
        );

        assert_eq!(
            linked_etag_from_headers(&headers).as_deref(),
            Some("b338a7ab5c81600a54be46c4cf950edb3761a52ae163e419beafd250976fb566")
        );
    }

    #[test]
    fn verification_requires_a_trusted_digest() {
        let actual = "b338a7ab5c81600a54be46c4cf950edb3761a52ae163e419beafd250976fb566";
        assert!(compare_download_hashes(actual, None, None)
            .expect_err("missing digest must fail closed")
            .contains("cannot be verified"));
    }

    #[test]
    fn cleanup_failure_preserves_the_primary_integrity_error() {
        let message = cleanup_result_message(
            "SHA-256 mismatch",
            "Part file",
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "cleanup denied",
            )),
        );
        assert!(message.starts_with("SHA-256 mismatch."));
        assert!(message.contains("Could not remove Part file"));
        assert!(!message.contains("Part file removed"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocking_file_io_remains_registered_until_the_operation_completes() {
        let state = Arc::new(DownloadState::default());
        let cancel = Arc::new(DownloadCancel::new());
        let (tx, _) = tokio::sync::broadcast::channel(2);
        state
            .reserve_job(
                "123e4567-e89b-12d3-a456-426614174002",
                unique_test_path("managed-flush.gguf"),
                Arc::clone(&cancel),
                tx,
            )
            .expect("reserve job");
        state.begin_background_task();

        let release = Arc::new(tokio::sync::Notify::new());
        let release_task = Arc::clone(&release);
        let state_task = Arc::clone(&state);
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let result = await_managed_file_io(async move {
                let _ = entered_tx.send(());
                release_task.notified().await;
                Ok(())
            })
            .await;
            state_task.finish_background_task();
            result
        });
        entered_rx.await.expect("operation entered");

        state.request_cancel_all_active();
        assert!(cancel.is_canceled());
        let (drained_tx, drained_rx) = std::sync::mpsc::channel();
        let state_waiter = Arc::clone(&state);
        let waiter = std::thread::spawn(move || {
            state_waiter.wait_for_background_tasks();
            let _ = drained_tx.send(());
        });
        assert!(drained_rx.recv_timeout(Duration::from_millis(50)).is_err());

        release.notify_one();
        task.await
            .expect("managed task")
            .expect("managed operation");
        drained_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("shutdown drain completes after operation release");
        waiter.join().expect("drain waiter");
        assert_eq!(*state.2.lock().expect("active task count"), 0);
    }

    #[test]
    fn active_destination_is_exclusive_until_every_terminal_state() {
        for terminal in ["ready", "error", "canceled"] {
            let destination = unique_test_path("owned-download.gguf");
            let state = Arc::new(DownloadState::default());
            let (first_tx, _) = tokio::sync::broadcast::channel(2);
            {
                let mut jobs = state.0.lock().expect("download state lock");
                reserve_download_job(
                    &mut jobs,
                    "first",
                    destination.clone(),
                    Arc::new(DownloadCancel::new()),
                    first_tx.clone(),
                )
                .expect("first reservation should succeed");
            }

            let (blocked_tx, _) = tokio::sync::broadcast::channel(2);
            let blocked = {
                let mut jobs = state.0.lock().expect("download state lock");
                reserve_download_job(
                    &mut jobs,
                    "second",
                    destination.clone(),
                    Arc::new(DownloadCancel::new()),
                    blocked_tx,
                )
                .expect_err("same active destination must be rejected")
            };
            assert!(blocked.contains("active job"));

            update_job_status(&state, "first", &first_tx, terminal, 10, 10, None);
            let (released_tx, _) = tokio::sync::broadcast::channel(2);
            let mut jobs = state.0.lock().expect("download state lock");
            assert_eq!(
                jobs.get("first").expect("terminal history remains").status,
                terminal
            );
            reserve_download_job(
                &mut jobs,
                "second",
                destination,
                Arc::new(DownloadCancel::new()),
                released_tx,
            )
            .expect("terminal job should release destination ownership");
            assert!(jobs.contains_key("first"), "completion stays observable");
        }
    }

    #[test]
    fn client_job_id_retry_is_idempotent_only_for_the_exact_request() {
        let state = DownloadState::default();
        let destination = unique_test_path("idempotent-request.gguf");
        let identity = DownloadRequestIdentity {
            url: "https://huggingface.co/org/repo/resolve/main/model.gguf".to_string(),
            dest: destination.to_string_lossy().to_string(),
            sha256: Some("a".repeat(64)),
        };
        let (first_tx, _) = tokio::sync::broadcast::channel(2);
        assert_eq!(
            state
                .reserve_request_job(
                    "123e4567-e89b-12d3-a456-426614174000",
                    destination.clone(),
                    identity.clone(),
                    Arc::new(DownloadCancel::new()),
                    first_tx,
                )
                .unwrap(),
            DownloadReservation::Created
        );

        let (retry_tx, _) = tokio::sync::broadcast::channel(2);
        assert_eq!(
            state
                .reserve_request_job(
                    "123e4567-e89b-12d3-a456-426614174000",
                    destination.clone(),
                    identity.clone(),
                    Arc::new(DownloadCancel::new()),
                    retry_tx,
                )
                .unwrap(),
            DownloadReservation::Existing
        );
        assert_eq!(state.0.lock().unwrap().len(), 1);

        let (conflict_tx, _) = tokio::sync::broadcast::channel(2);
        let mut conflicting = identity;
        conflicting.url = "https://huggingface.co/org/repo/resolve/main/other.gguf".to_string();
        let error = state
            .reserve_request_job(
                "123e4567-e89b-12d3-a456-426614174000",
                destination,
                conflicting,
                Arc::new(DownloadCancel::new()),
                conflict_tx,
            )
            .expect_err("same id with another payload must conflict");
        assert!(error.contains("conflicts"));
        assert_eq!(state.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn cancel_before_reservation_is_consumed_as_terminal_without_spawning() {
        let state = DownloadState::default();
        let job_id = "123e4567-e89b-12d3-a456-426614174001";
        let destination = unique_test_path("cancel-before-reserve.gguf");
        let identity = DownloadRequestIdentity {
            url: "https://huggingface.co/org/repo/resolve/main/model.gguf".to_string(),
            dest: destination.to_string_lossy().to_string(),
            sha256: Some("b".repeat(64)),
        };

        assert_eq!(
            state.request_cancel_job(job_id),
            DownloadCancelRequest::Pending
        );
        let (tx, _) = tokio::sync::broadcast::channel(2);
        assert_eq!(
            state
                .reserve_request_job(
                    job_id,
                    destination.clone(),
                    identity,
                    Arc::new(DownloadCancel::new()),
                    tx,
                )
                .unwrap(),
            DownloadReservation::Canceled
        );
        let jobs = state.0.lock().unwrap();
        let job = jobs.get(job_id).expect("terminal tombstone job");
        assert_eq!(job.status, "canceled");
        assert!(!job.owns_destination);
        assert!(job.cancel.is_canceled());
        assert!(!destination.exists());
        assert_eq!(*state.2.lock().unwrap(), 0);
        assert!(state.4.lock().unwrap().is_empty());
    }

    #[test]
    fn download_job_id_requires_canonical_uuid_shape() {
        assert!(is_canonical_uuid("123e4567-e89b-12d3-a456-426614174000"));
        assert!(is_canonical_uuid("123E4567-E89B-12D3-A456-426614174000"));
        assert!(!is_canonical_uuid("job-1"));
        assert!(!is_canonical_uuid("123e4567e89b12d3a456426614174000"));
        assert!(!is_canonical_uuid("123e4567-e89b-12d3-a456-42661417400z"));
    }

    #[test]
    fn windows_download_mutation_contract_fails_closed() {
        assert!(ensure_secure_download_mutation_platform(false).is_ok());
        let state = Arc::new(DownloadState::default());
        let error = hf_download_start_inner_for_platform(
            "not-a-url".to_string(),
            "relative/path.gguf".to_string(),
            None,
            "123e4567-e89b-12d3-a456-426614174000".to_string(),
            Arc::clone(&state),
            true,
        )
        .expect_err("Windows mutation must remain disabled before validation or I/O");
        assert!(error.contains("unavailable on Windows"));
        assert!(error.contains("reparse-safe"));
        assert!(state.0.lock().unwrap().is_empty());
        assert_eq!(*state.2.lock().unwrap(), 0);
    }

    #[test]
    fn terminal_download_history_is_bounded() {
        let state = Arc::new(DownloadState::default());
        for index in 0..(MAX_TERMINAL_HISTORY + 10) {
            let job_id = format!("terminal-{index}");
            let (tx, _) = tokio::sync::broadcast::channel(2);
            {
                let mut jobs = state.0.lock().expect("download state lock");
                reserve_download_job(
                    &mut jobs,
                    &job_id,
                    unique_test_path(&format!("terminal-{index}.gguf")),
                    Arc::new(DownloadCancel::new()),
                    tx.clone(),
                )
                .expect("reserve terminal fixture");
            }
            update_job_status(&state, &job_id, &tx, "ready", 1, 1, None);
        }

        let (active_tx, _) = tokio::sync::broadcast::channel(2);
        let mut jobs = state.0.lock().expect("download state lock");
        reserve_download_job(
            &mut jobs,
            "active",
            unique_test_path("active-history-bound.gguf"),
            Arc::new(DownloadCancel::new()),
            active_tx,
        )
        .expect("trigger terminal history pruning");
        assert!(jobs.contains_key("active"));
        assert!(jobs.values().filter(|job| !job.owns_destination).count() <= MAX_TERMINAL_HISTORY);
    }

    #[tokio::test]
    async fn existing_complete_dest_marks_ready_without_network() {
        let dest_path = unique_test_path("complete-dest.bin");
        let part_path = std::path::PathBuf::from(format!("{}.part", dest_path.to_string_lossy()));
        tokio::fs::write(&dest_path, b"already complete")
            .await
            .expect("write existing dest");
        let sha = sha256_file_from_disk(&dest_path)
            .await
            .expect("hash existing dest");
        let state = Arc::new(DownloadState::default());
        let (tx, _) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(DownloadCancel::new());
        let job_id = "existing-complete-dest".to_string();
        {
            let mut guard = state.0.lock().expect("download state lock");
            guard.insert(
                job_id.clone(),
                DownloadJob {
                    status: "queued".to_string(),
                    received: 0,
                    total: 0,
                    error: None,
                    destination: dest_path.clone(),
                    owns_destination: true,
                    finished_at: None,
                    request_identity: None,
                    cancel: Arc::clone(&cancel),
                    tx: tx.clone(),
                },
            );
        }

        run_download_task(DownloadTask {
            url: "https://huggingface.co/org/repo/resolve/main/model.gguf".to_string(),
            dest: dest_path.to_string_lossy().to_string(),
            part_path: part_path.clone(),
            sha256: Some(sha),
            job_id: job_id.clone(),
            state: Arc::clone(&state),
            tx,
            cancel: Arc::clone(&cancel),
            timeouts: DownloadTimeouts::default(),
            secure_target: secure_target_for_test(&dest_path),
            hash_test_hook: None,
        })
        .await;

        let snapshot = {
            let guard = state.0.lock().expect("download state lock");
            guard.get(&job_id).expect("job should exist").snapshot()
        };
        assert_eq!(snapshot.status, "ready");
        assert_eq!(snapshot.received, 16);
        assert_eq!(snapshot.total, 16);
        assert!(dest_path.exists());
        assert!(!part_path.exists());

        let _ = std::fs::remove_file(&dest_path);
        let _ = std::fs::remove_file(&part_path);
    }

    #[tokio::test]
    async fn existing_dest_without_trusted_digest_never_marks_ready() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("read test server address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept metadata request");
            let mut buffer = [0u8; 1024];
            let _ = stream.read(&mut buffer);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .expect("write metadata response");
        });

        let dest_path = unique_test_path("unverified-existing.bin");
        let part_path = std::path::PathBuf::from(format!("{}.part", dest_path.to_string_lossy()));
        tokio::fs::write(&dest_path, b"unverified")
            .await
            .expect("write existing dest");
        let state = Arc::new(DownloadState::default());
        let (tx, _) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(DownloadCancel::new());
        let job_id = "existing-unverified-dest".to_string();
        {
            let mut guard = state.0.lock().expect("download state lock");
            guard.insert(
                job_id.clone(),
                DownloadJob {
                    status: "queued".to_string(),
                    received: 0,
                    total: 0,
                    error: None,
                    destination: dest_path.clone(),
                    owns_destination: true,
                    finished_at: None,
                    request_identity: None,
                    cancel: Arc::clone(&cancel),
                    tx: tx.clone(),
                },
            );
        }

        run_download_task(DownloadTask {
            url: format!("http://{addr}/model.bin"),
            dest: dest_path.to_string_lossy().to_string(),
            part_path: part_path.clone(),
            sha256: None,
            job_id: job_id.clone(),
            state: Arc::clone(&state),
            tx,
            cancel: Arc::clone(&cancel),
            timeouts: DownloadTimeouts::default(),
            secure_target: secure_target_for_test(&dest_path),
            hash_test_hook: None,
        })
        .await;
        server.join().expect("metadata server should finish");

        let snapshot = {
            let guard = state.0.lock().expect("download state lock");
            guard.get(&job_id).expect("job should exist").snapshot()
        };
        assert_eq!(snapshot.status, "error");
        assert!(snapshot
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("cannot be trusted"));
        assert!(
            dest_path.exists(),
            "unverified existing file is not trusted or overwritten"
        );
        assert!(!part_path.exists());

        let _ = std::fs::remove_file(&dest_path);
    }

    #[tokio::test]
    async fn existing_dest_hash_mismatch_fails_closed_and_removes_untrusted_file() {
        let dest_path = unique_test_path("mismatched-existing.bin");
        let part_path = std::path::PathBuf::from(format!("{}.part", dest_path.to_string_lossy()));
        tokio::fs::write(&dest_path, b"corrupt")
            .await
            .expect("write existing dest");
        let state = Arc::new(DownloadState::default());
        let (tx, _) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(DownloadCancel::new());
        let job_id = "existing-mismatched-dest".to_string();
        {
            let mut guard = state.0.lock().expect("download state lock");
            guard.insert(
                job_id.clone(),
                DownloadJob {
                    status: "queued".to_string(),
                    received: 0,
                    total: 0,
                    error: None,
                    destination: dest_path.clone(),
                    owns_destination: true,
                    finished_at: None,
                    request_identity: None,
                    cancel: Arc::clone(&cancel),
                    tx: tx.clone(),
                },
            );
        }

        run_download_task(DownloadTask {
            url: "https://huggingface.co/org/repo/resolve/main/model.gguf".to_string(),
            dest: dest_path.to_string_lossy().to_string(),
            part_path,
            sha256: Some("0".repeat(64)),
            job_id: job_id.clone(),
            state: Arc::clone(&state),
            tx,
            cancel,
            timeouts: DownloadTimeouts::default(),
            secure_target: secure_target_for_test(&dest_path),
            hash_test_hook: None,
        })
        .await;

        let snapshot = {
            let guard = state.0.lock().expect("download state lock");
            guard.get(&job_id).expect("job should exist").snapshot()
        };
        assert_eq!(snapshot.status, "error");
        assert!(snapshot
            .error
            .as_deref()
            .unwrap_or_default()
            .starts_with("SHA-256 mismatch"));
        assert!(
            !dest_path.exists(),
            "hash-mismatched destination must not remain ready"
        );
    }

    #[tokio::test]
    async fn stream_error_keeps_partial_file_for_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("read test server address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept test request");
            let mut buffer = [0u8; 1024];
            let _ = stream.read(&mut buffer);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nX-Linked-ETag: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n\r\npartial",
                )
                .expect("write truncated response");
        });

        let dest_path = unique_test_path("stream-error.bin");
        let part_path = std::path::PathBuf::from(format!("{}.part", dest_path.to_string_lossy()));
        let state = Arc::new(DownloadState::default());
        let (tx, _) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(DownloadCancel::new());
        let job_id = "stream-error-keeps-partial".to_string();
        {
            let mut guard = state.0.lock().expect("download state lock");
            guard.insert(
                job_id.clone(),
                DownloadJob {
                    status: "queued".to_string(),
                    received: 0,
                    total: 0,
                    error: None,
                    destination: dest_path.clone(),
                    owns_destination: true,
                    finished_at: None,
                    request_identity: None,
                    cancel: Arc::clone(&cancel),
                    tx: tx.clone(),
                },
            );
        }

        run_download_task(DownloadTask {
            url: format!("http://{addr}/model.bin"),
            dest: dest_path.to_string_lossy().to_string(),
            part_path: part_path.clone(),
            sha256: None,
            job_id: job_id.clone(),
            state: Arc::clone(&state),
            tx,
            cancel,
            timeouts: DownloadTimeouts::default(),
            secure_target: secure_target_for_test(&dest_path),
            hash_test_hook: None,
        })
        .await;
        server.join().expect("test server thread should finish");

        let snapshot = {
            let guard = state.0.lock().expect("download state lock");
            guard.get(&job_id).expect("job should exist").snapshot()
        };
        assert_eq!(snapshot.status, "error");
        assert_eq!(snapshot.received, 7);
        assert_eq!(snapshot.total, 12);
        assert!(snapshot
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("Partial download kept for retry"));
        assert!(part_path.exists());
        assert!(!dest_path.exists());
        assert_eq!(
            std::fs::read(&part_path).expect("partial file should be readable"),
            b"partial"
        );

        let _ = std::fs::remove_file(&part_path);
        let _ = std::fs::remove_file(&dest_path);
    }

    #[test]
    fn terminal_status_transitions_are_monotonic_and_canceled_never_becomes_ready() {
        assert!(can_commit_download_status("downloading", "ready"));
        assert!(can_commit_download_status("downloading", "canceled"));
        assert!(!can_commit_download_status("canceled", "ready"));
        assert!(!can_commit_download_status("ready", "canceled"));
        assert!(!can_commit_download_status("error", "ready"));
        assert!(can_commit_download_status("canceled", "canceled"));

        let state = Arc::new(DownloadState::default());
        let (tx, mut rx) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(DownloadCancel::new());
        {
            let mut jobs = state.0.lock().unwrap();
            reserve_download_job(
                &mut jobs,
                "mono",
                unique_test_path("mono.bin"),
                Arc::clone(&cancel),
                tx.clone(),
            )
            .unwrap();
        }
        update_job_status(&state, "mono", &tx, "canceled", 1, 2, None);
        update_job_status(&state, "mono", &tx, "ready", 2, 2, None);
        let status = state.0.lock().unwrap().get("mono").unwrap().status.clone();
        assert_eq!(status, "canceled");
        assert_eq!(rx.try_recv().unwrap().status, "canceled");
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn cancel_ack_and_terminal_commit_are_linearizable_under_race() {
        for iteration in 0..100 {
            let state = Arc::new(DownloadState::default());
            let (tx, _) = tokio::sync::broadcast::channel(8);
            let cancel = Arc::new(DownloadCancel::new());
            let job_id = format!("cancel-ready-race-{iteration}");
            state.0.lock().unwrap().insert(
                job_id.clone(),
                DownloadJob {
                    status: "downloading".to_string(),
                    received: 1,
                    total: 2,
                    error: None,
                    destination: unique_test_path("cancel-ready-race.bin"),
                    owns_destination: true,
                    finished_at: None,
                    request_identity: None,
                    cancel,
                    tx: tx.clone(),
                },
            );
            let barrier = Arc::new(Barrier::new(3));
            let cancel_state = Arc::clone(&state);
            let cancel_job = job_id.clone();
            let cancel_barrier = Arc::clone(&barrier);
            let cancel_thread = std::thread::spawn(move || {
                cancel_barrier.wait();
                cancel_state.request_cancel_job(&cancel_job)
            });
            let ready_state = Arc::clone(&state);
            let ready_job = job_id.clone();
            let ready_tx = tx.clone();
            let ready_barrier = Arc::clone(&barrier);
            let ready_thread = std::thread::spawn(move || {
                ready_barrier.wait();
                update_job_status(&ready_state, &ready_job, &ready_tx, "ready", 2, 2, None);
            });
            barrier.wait();
            let cancel_result = cancel_thread.join().expect("cancel thread");
            ready_thread.join().expect("ready thread");
            let status = state.0.lock().unwrap().get(&job_id).unwrap().status.clone();
            match cancel_result {
                DownloadCancelRequest::Accepted => assert_eq!(status, "canceled"),
                DownloadCancelRequest::Terminal => assert_eq!(status, "ready"),
                DownloadCancelRequest::Pending => panic!("reserved job became pending"),
                DownloadCancelRequest::NotFound => panic!("reserved job disappeared"),
            }
        }
    }

    #[test]
    fn late_progress_after_cancel_keeps_destination_owned_until_terminal() {
        let state = Arc::new(DownloadState::default());
        let (tx, mut rx) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(DownloadCancel::new());
        state.0.lock().unwrap().insert(
            "cancel-ownership".to_string(),
            DownloadJob {
                status: "downloading".to_string(),
                received: 1,
                total: 3,
                error: None,
                destination: unique_test_path("cancel-ownership.bin"),
                owns_destination: true,
                finished_at: None,
                request_identity: None,
                cancel,
                tx: tx.clone(),
            },
        );
        assert_eq!(
            state.request_cancel_job("cancel-ownership"),
            DownloadCancelRequest::Accepted
        );
        update_job_status(&state, "cancel-ownership", &tx, "downloading", 2, 3, None);
        {
            let jobs = state.0.lock().unwrap();
            let job = jobs.get("cancel-ownership").unwrap();
            assert_eq!(job.status, "downloading");
            assert_eq!(job.received, 1, "late progress is ignored");
            assert!(job.owns_destination);
        }
        assert!(rx.try_recv().is_err());

        // Even if the worker reaches an error/ready branch, accepted cancel is
        // the linearized terminal result and only now releases ownership.
        update_job_status(
            &state,
            "cancel-ownership",
            &tx,
            "error",
            2,
            3,
            Some("late error".to_string()),
        );
        let jobs = state.0.lock().unwrap();
        let job = jobs.get("cancel-ownership").unwrap();
        assert_eq!(job.status, "canceled");
        assert!(!job.owns_destination);
        assert_eq!(rx.try_recv().expect("terminal snapshot").status, "canceled");
    }

    #[tokio::test]
    async fn cancel_wakes_header_wait_before_body_arrives() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (accepted_tx, accepted_rx) = oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (_stream, _) = listener.accept().expect("accept");
            let _ = accepted_tx.send(());
            // Keep the TCP connection open without waiting for request bytes.
            // recv_timeout bounds the test server even if the client regresses.
            let _ = release_rx.recv_timeout(Duration::from_secs(2));
        });

        let dest_path = unique_test_path("cancel-headers.bin");
        let part_path = std::path::PathBuf::from(format!("{}.part", dest_path.to_string_lossy()));
        let state = Arc::new(DownloadState::default());
        let (tx, _) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(DownloadCancel::new());
        let job_id = "cancel-headers".to_string();
        {
            let mut jobs = state.0.lock().unwrap();
            jobs.insert(
                job_id.clone(),
                DownloadJob {
                    status: "queued".to_string(),
                    received: 0,
                    total: 0,
                    error: None,
                    destination: dest_path.clone(),
                    owns_destination: true,
                    finished_at: None,
                    request_identity: None,
                    cancel: Arc::clone(&cancel),
                    tx: tx.clone(),
                },
            );
        }

        let task = tokio::spawn(run_download_task(DownloadTask {
            url: format!("http://{addr}/slow"),
            dest: dest_path.to_string_lossy().to_string(),
            part_path,
            sha256: Some("a".repeat(64)),
            job_id: job_id.clone(),
            state: Arc::clone(&state),
            tx,
            cancel: Arc::clone(&cancel),
            timeouts: DownloadTimeouts {
                connect: Duration::from_secs(2),
                headers: Duration::from_secs(2),
                read_idle: Duration::from_millis(200),
            },
            secure_target: secure_target_for_test(&dest_path),
            hash_test_hook: None,
        }));

        tokio::time::timeout(Duration::from_secs(1), accepted_rx)
            .await
            .expect("client must connect before cancellation")
            .expect("accept signal");
        cancel.request();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("header wait must be canceled promptly")
            .expect("download task join");

        let status = state.0.lock().unwrap().get(&job_id).unwrap().status.clone();
        assert_eq!(status, "canceled");
        let _ = release_tx.send(());
        server.join().expect("bounded test server must finish");
        let _ = std::fs::remove_file(&dest_path);
    }

    #[tokio::test]
    async fn cancel_wakes_stalled_body_chunk_wait() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let body = b"hello-world-bytes";
        let digest = {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(body);
            hasher
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        };
        let digest_for_server = digest.clone();
        let (stalled_tx, stalled_rx) = oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .expect("request read timeout");
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nX-Linked-ETag: \"{digest_for_server}\"\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(headers.as_bytes()).expect("headers");
            stream.write_all(&body[..5]).expect("first chunk");
            let _ = stream.flush();
            let _ = stalled_tx.send(());
            let _ = release_rx.recv_timeout(Duration::from_secs(2));
        });

        let dest_path = unique_test_path("cancel-body.bin");
        let part_path = std::path::PathBuf::from(format!("{}.part", dest_path.to_string_lossy()));
        let state = Arc::new(DownloadState::default());
        let (tx, _) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(DownloadCancel::new());
        let job_id = "cancel-body".to_string();
        {
            let mut jobs = state.0.lock().unwrap();
            jobs.insert(
                job_id.clone(),
                DownloadJob {
                    status: "queued".to_string(),
                    received: 0,
                    total: 0,
                    error: None,
                    destination: dest_path.clone(),
                    owns_destination: true,
                    finished_at: None,
                    request_identity: None,
                    cancel: Arc::clone(&cancel),
                    tx: tx.clone(),
                },
            );
        }

        let task = tokio::spawn(run_download_task(DownloadTask {
            url: format!("http://{addr}/model.bin"),
            dest: dest_path.to_string_lossy().to_string(),
            part_path: part_path.clone(),
            sha256: Some(digest),
            job_id: job_id.clone(),
            state: Arc::clone(&state),
            tx,
            cancel: Arc::clone(&cancel),
            timeouts: DownloadTimeouts {
                connect: Duration::from_secs(2),
                headers: Duration::from_secs(2),
                read_idle: Duration::from_secs(2),
            },
            secure_target: secure_target_for_test(&dest_path),
            hash_test_hook: None,
        }));

        tokio::time::timeout(Duration::from_secs(1), stalled_rx)
            .await
            .expect("body must enter a stalled-chunk wait")
            .expect("stall signal");
        cancel.request();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("body wait must be canceled promptly")
            .expect("download task join");

        let status = state.0.lock().unwrap().get(&job_id).unwrap().status.clone();
        assert_eq!(status, "canceled");
        assert!(!can_commit_download_status(&status, "ready"));
        let _ = release_tx.send(());
        server.join().expect("bounded test server must finish");
        let _ = std::fs::remove_file(&part_path);
        let _ = std::fs::remove_file(&dest_path);
    }

    #[test]
    fn finalize_decision_seam_preserves_part_or_dest_never_ready_after_cancel() {
        assert_eq!(
            finalize_decision_before_rename(true),
            FinalizeDecision::CancelKeepPart
        );
        assert_eq!(
            finalize_decision_before_rename(false),
            FinalizeDecision::ProceedRename
        );
        assert_eq!(
            finalize_decision_after_rename(true),
            FinalizeDecision::CancelKeepDest
        );
        assert_eq!(
            finalize_decision_after_rename(false),
            FinalizeDecision::MarkReady
        );
        assert!(!can_commit_download_status("canceled", "ready"));
    }

    #[tokio::test]
    async fn cancel_wakeup_is_race_free_under_stress() {
        // Regression for Notify::notify_waiters lost-wakeup: watch-based cancel
        // must wake every waiter even when request races the subscribe/check.
        for _ in 0..200 {
            let cancel = Arc::new(DownloadCancel::new());
            let cancel_wait = Arc::clone(&cancel);
            let waiter = tokio::spawn(async move {
                cancel_wait.cancelled().await;
            });
            // Yield so the waiter is likely parked in changed().await, then cancel.
            tokio::task::yield_now().await;
            cancel.request();
            tokio::time::timeout(Duration::from_millis(200), waiter)
                .await
                .expect("cancel must wake waiter without lost wakeup")
                .expect("waiter join");
        }
    }

    #[tokio::test]
    async fn cancel_during_on_disk_hash_interrupts_deterministically() {
        let (first_chunk_tx, first_chunk_rx) = oneshot::channel();
        let mut reader = OneChunkThenPending {
            emitted: false,
            first_chunk: Some(first_chunk_tx),
        };
        let cancel = Arc::new(DownloadCancel::new());
        let cancel_for_hash = Arc::clone(&cancel);
        let hash = tokio::spawn(async move {
            sha256_reader_cancellable(&mut reader, &cancel_for_hash, Duration::from_secs(5), None)
                .await
        });

        first_chunk_rx
            .await
            .expect("hash reader must signal after its first chunk");
        cancel.request();
        let err = tokio::time::timeout(Duration::from_secs(1), hash)
            .await
            .expect("hash cancellation must be prompt")
            .expect("hash task join")
            .expect_err("hash must interrupt");
        assert_eq!(err.kind(), std::io::ErrorKind::Interrupted);
        assert!(cancel.is_canceled());
    }

    #[tokio::test]
    async fn cancel_during_hash_stage_of_existing_dest_marks_canceled_not_ready() {
        let dest_path = unique_test_path("hash-stage-cancel.bin");
        let part_path = std::path::PathBuf::from(format!("{}.part", dest_path.to_string_lossy()));
        let payload = b"existing destination hash fixture";
        tokio::fs::write(&dest_path, payload)
            .await
            .expect("write existing destination");
        let expected = {
            let mut hasher = Sha256::new();
            hasher.update(payload);
            hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        };
        let state = Arc::new(DownloadState::default());
        let (tx, mut rx) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(DownloadCancel::new());
        let job_id = "hash-stage-cancel".to_string();
        {
            let mut jobs = state.0.lock().unwrap();
            jobs.insert(
                job_id.clone(),
                DownloadJob {
                    status: "queued".to_string(),
                    received: 0,
                    total: 0,
                    error: None,
                    destination: dest_path.clone(),
                    owns_destination: true,
                    finished_at: None,
                    request_identity: None,
                    cancel: Arc::clone(&cancel),
                    tx: tx.clone(),
                },
            );
        }
        let hook = Arc::new(HashReadTestHook::new());
        let task = tokio::spawn(run_download_task(DownloadTask {
            url: "https://huggingface.co/org/repo/resolve/main/model.gguf".to_string(),
            dest: dest_path.to_string_lossy().to_string(),
            part_path: part_path.clone(),
            sha256: Some(expected),
            job_id: job_id.clone(),
            state: Arc::clone(&state),
            tx: tx.clone(),
            cancel: Arc::clone(&cancel),
            timeouts: DownloadTimeouts::default(),
            secure_target: secure_target_for_test(&dest_path),
            hash_test_hook: Some(Arc::clone(&hook)),
        }));
        hook.first_chunk.notified().await;
        cancel.request();
        hook.resume.notify_one();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("production existing-destination hash must cancel promptly")
            .expect("download task join");
        let status = state.0.lock().unwrap().get(&job_id).unwrap().status.clone();
        assert_eq!(status, "canceled");
        assert_eq!(rx.try_recv().expect("canceled snapshot").status, "canceled");
        assert!(rx.try_recv().is_err());
        assert!(!can_commit_download_status(&status, "ready"));
        assert!(
            dest_path.exists(),
            "cancel preserves the existing destination"
        );
        let _ = std::fs::remove_file(&dest_path);
        let _ = std::fs::remove_file(&part_path);
    }

    #[tokio::test]
    async fn cancel_wakes_auxiliary_head_that_never_responds() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind metadata server");
        let addr = listener.local_addr().expect("metadata address");
        let (accepted_tx, accepted_rx) = oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel::<()>(0);
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept metadata HEAD");
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .expect("metadata request timeout");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).expect("read metadata HEAD");
            let _ = accepted_tx.send(());
            let _ = release_rx.recv_timeout(Duration::from_secs(2));
        });
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .build()
            .expect("metadata client");
        let cancel = Arc::new(DownloadCancel::new());
        let cancel_for_head = Arc::clone(&cancel);
        let head = tokio::spawn(async move {
            fetch_remote_download_metadata(
                &client,
                &format!("http://{addr}/model.bin"),
                &cancel_for_head,
                DownloadTimeouts {
                    connect: Duration::from_secs(2),
                    headers: Duration::from_secs(5),
                    read_idle: Duration::from_secs(2),
                },
            )
            .await
        });
        accepted_rx.await.expect("metadata server accepted HEAD");
        cancel.request();
        let result = tokio::time::timeout(Duration::from_secs(1), head)
            .await
            .expect("auxiliary HEAD cancellation is bounded")
            .expect("metadata task join");
        assert!(matches!(result, Err(AuxiliaryHeadError::Canceled)));
        let _ = release_tx.send(());
        server.join().expect("metadata server exits");
    }

    #[tokio::test]
    async fn cancel_during_416_completed_part_hash_keeps_part_and_never_ready() {
        let dest_path = unique_test_path("hash-416-dest.bin");
        let part_path = std::path::PathBuf::from(format!("{}.part", dest_path.to_string_lossy()));
        let payload = b"completed resumed part fixture";
        tokio::fs::write(&part_path, payload)
            .await
            .expect("write completed part");
        let expected = {
            let mut hasher = Sha256::new();
            hasher.update(payload);
            hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        };
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind 416 server");
        let addr = listener.local_addr().expect("416 address");
        let total = payload.len();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept 416 request");
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .expect("request timeout");
            let mut request = [0u8; 2048];
            let read = stream.read(&mut request).expect("read range request");
            assert!(String::from_utf8_lossy(&request[..read])
                .to_ascii_lowercase()
                .contains("range: bytes="));
            let response = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream
                .write_all(response.as_bytes())
                .expect("write 416 response");
        });

        let state = Arc::new(DownloadState::default());
        let (tx, mut rx) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(DownloadCancel::new());
        let job_id = "hash-416-cancel".to_string();
        state.0.lock().unwrap().insert(
            job_id.clone(),
            DownloadJob {
                status: "queued".to_string(),
                received: payload.len() as u64,
                total: payload.len() as u64,
                error: None,
                destination: dest_path.clone(),
                owns_destination: true,
                finished_at: None,
                request_identity: None,
                cancel: Arc::clone(&cancel),
                tx: tx.clone(),
            },
        );
        let hook = Arc::new(HashReadTestHook::new());
        let task = tokio::spawn(run_download_task(DownloadTask {
            url: format!("http://{addr}/model.bin"),
            dest: dest_path.to_string_lossy().to_string(),
            part_path: part_path.clone(),
            sha256: Some(expected),
            job_id: job_id.clone(),
            state: Arc::clone(&state),
            tx,
            cancel: Arc::clone(&cancel),
            timeouts: DownloadTimeouts {
                connect: Duration::from_secs(1),
                headers: Duration::from_secs(1),
                read_idle: Duration::from_secs(1),
            },
            secure_target: secure_target_for_test(&dest_path),
            hash_test_hook: Some(Arc::clone(&hook)),
        }));
        hook.first_chunk.notified().await;
        cancel.request();
        hook.resume.notify_one();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("416 hash must cancel promptly")
            .expect("download task join");
        server.join().expect("bounded 416 server");

        let snapshot = state.0.lock().unwrap().get(&job_id).unwrap().snapshot();
        assert_eq!(snapshot.status, "canceled");
        assert_eq!(rx.try_recv().expect("terminal snapshot").status, "canceled");
        assert!(rx.try_recv().is_err());
        assert!(
            part_path.exists(),
            "canceled completed part remains resumable"
        );
        assert!(!dest_path.exists());
        let _ = std::fs::remove_file(&part_path);
        let _ = std::fs::remove_file(&dest_path);
    }
}
