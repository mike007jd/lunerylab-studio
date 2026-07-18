use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;
use tokio::io::AsyncWriteExt;

use crate::get_http_client;
use crate::profile::profile_models_root_path;

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

pub(crate) struct DownloadJob {
    pub(crate) status: String,
    pub(crate) received: u64,
    pub(crate) total: u64,
    pub(crate) error: Option<String>,
    pub(crate) cancel: Arc<AtomicBool>,
    /// Broadcast channel sender — SSE bridge subscribers drain from a receiver.
    pub(crate) tx: tokio::sync::broadcast::Sender<JobSnapshot>,
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
#[derive(Default)]
pub struct DownloadState(pub(crate) Mutex<HashMap<String, DownloadJob>>);

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
    if job_id.is_empty() || job_id.len() > 128 {
        return Err("Invalid job_id".to_string());
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
    let dest = dest_path.to_string_lossy().to_string();

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

    // Create destination parent directory.
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Could not create model directory: {err}"))?;
        let root = canonical_models_root_for_path(&dest_path)?;
        let parent_canon = parent
            .canonicalize()
            .map_err(|err| format!("Could not verify model directory: {err}"))?;
        if !parent_canon.starts_with(&root) {
            return Err("Download destination escapes the model directory".to_string());
        }
    }

    // Set up a broadcast channel for SSE progress ticks (capacity 64 frames).
    let (tx, _) = tokio::sync::broadcast::channel::<JobSnapshot>(64);
    let cancel = Arc::new(AtomicBool::new(false));

    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Download state lock poisoned".to_string())?;
        // E1: Sweep terminal jobs before inserting to bound HashMap growth.
        // Only "ready", "error", and "canceled" are swept — active ("queued",
        // "downloading") and any cancel-flagged in-flight jobs are left intact.
        // Done here (not on terminal transition) so post-completion status/SSE
        // reads for the just-finished job are never affected.
        guard.retain(|_, job| !matches!(job.status.as_str(), "ready" | "error" | "canceled"));
        if let Some(existing) = guard.get(&job_id) {
            if existing.status == "downloading" {
                return Err("Job already in progress".to_string());
            }
        }
        guard.insert(
            job_id.clone(),
            DownloadJob {
                status: "queued".to_string(),
                received: 0,
                total: 0,
                error: None,
                cancel: Arc::clone(&cancel),
                tx: tx.clone(),
            },
        );
    }

    let state_clone = Arc::clone(&state);
    tauri::async_runtime::spawn(async move {
        run_download_task(
            url,
            dest,
            part_path,
            sha256,
            job_id,
            state_clone,
            tx,
            cancel,
        )
        .await;
    });

    Ok(())
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
async fn run_download_task(
    url: String,
    dest: String,
    part_path: PathBuf,
    sha256: Option<String>,
    job_id: String,
    state: Arc<DownloadState>,
    tx: tokio::sync::broadcast::Sender<JobSnapshot>,
    cancel: Arc<AtomicBool>,
) {
    let dest_path = PathBuf::from(&dest);
    if dest_path.is_file() {
        let existing_dest_bytes = dest_path.metadata().map(|m| m.len()).unwrap_or(0);
        let linked_etag = if sha256.is_none() {
            fetch_hf_linked_etag(&url).await.ok().flatten()
        } else {
            None
        };
        if sha256.is_some() || linked_etag.is_some() {
            match sha256_file_from_disk(&dest_path).await {
                Ok(actual)
                    if compare_download_hashes(
                        &actual,
                        sha256.as_deref(),
                        linked_etag.as_deref(),
                    )
                    .is_ok() =>
                {
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
                Ok(_) => {
                    let _ = tokio::fs::remove_file(&dest_path).await;
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
        } else {
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
    }

    // Determine how many bytes we already have (resume).
    let existing_bytes = if part_path.exists() {
        part_path.metadata().map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    // Build the HTTP request with optional Range header.
    // E6: Use the process-wide shared client (connection-pool reuse across concurrent
    // downloads). Falls back to inline build on first-init race; error path unchanged.
    let client = match get_http_client() {
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

    let response = match request.send().await {
        Ok(r) => r,
        Err(err) => {
            set_job_error(&state, &job_id, &tx, &format!("Request failed: {err}"));
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
            match fetch_remote_download_metadata(&client, &url).await {
                Ok(metadata) => {
                    if remote_total.is_none() {
                        remote_total = metadata.total;
                    }
                    if linked_etag.is_none() {
                        linked_etag = metadata.linked_etag;
                    }
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
                let actual = match sha256_file_from_disk(&part_path).await {
                    Ok(digest) => digest,
                    Err(err) => {
                        let _ = tokio::fs::remove_file(&part_path).await;
                        set_job_error(
                            &state,
                            &job_id,
                            &tx,
                            &format!(
                                "Could not verify completed partial download: {err}. Part file removed."
                            ),
                        );
                        return;
                    }
                };
                if let Err(message) =
                    compare_download_hashes(&actual, sha256.as_deref(), linked_etag.as_deref())
                {
                    let _ = tokio::fs::remove_file(&part_path).await;
                    set_job_error(
                        &state,
                        &job_id,
                        &tx,
                        &format!("{message}. Part file removed."),
                    );
                    return;
                }
                if let Err(err) = tokio::fs::rename(&part_path, &dest).await {
                    set_job_error(
                        &state,
                        &job_id,
                        &tx,
                        &format!("Could not finalize file: {err}"),
                    );
                    return;
                }
                update_job_status(
                    &state,
                    &job_id,
                    &tx,
                    "ready",
                    existing_bytes,
                    remote_total,
                    None,
                );
                return;
            }
            PartialDownloadState::Oversized => {
                let _ = tokio::fs::remove_file(&part_path).await;
                set_job_error(
                    &state,
                    &job_id,
                    &tx,
                    &format!(
                        "Partial download is larger than the remote file ({existing_bytes} > {remote_total}). Part file removed; retry the download."
                    ),
                );
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
        linked_etag = fetch_hf_linked_etag(&url).await.ok().flatten();
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
        let f = match tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&part_path)
            .await
        {
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
        let f = match tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&part_path)
            .await
        {
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
        if cancel.load(Ordering::Relaxed) {
            if let Err(err) = file.flush().await {
                let _ = tokio::fs::remove_file(&part_path).await;
                set_job_error(
                    &state,
                    &job_id,
                    &tx,
                    &format!("Could not preserve canceled partial download: {err}"),
                );
                return;
            }
            update_job_status(&state, &job_id, &tx, "canceled", received, total, None);
            // Leave the .part file in place for future resume.
            return;
        }

        match stream.next().await {
            Some(Ok(chunk)) => {
                // chunk is bytes::Bytes (owned, Sized)
                if let Err(err) = file.write_all(chunk.as_ref()).await {
                    let _ = tokio::fs::remove_file(&part_path).await;
                    set_job_error(&state, &job_id, &tx, &format!("Write error: {err}"));
                    return;
                }
                received += chunk.len() as u64;
                if let Some(ref mut h) = hasher {
                    h.update(chunk.as_ref());
                }
                // Throttle progress ticks to ~250 ms.
                if last_tick.elapsed() >= Duration::from_millis(250) {
                    update_job_status(&state, &job_id, &tx, "downloading", received, total, None);
                    last_tick = Instant::now();
                }
            }
            Some(Err(ref err)) => {
                if let Err(flush_err) = file.flush().await {
                    let _ = tokio::fs::remove_file(&part_path).await;
                    set_job_error(
                        &state,
                        &job_id,
                        &tx,
                        &format!(
                            "Stream error: {err}. Partial download could not be preserved: {flush_err}"
                        ),
                    );
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
            None => break, // stream exhausted
        }
    }

    // Flush and close the file.
    if let Err(err) = file.flush().await {
        let _ = tokio::fs::remove_file(&part_path).await;
        set_job_error(&state, &job_id, &tx, &format!("Flush error: {err}"));
        return;
    }
    drop(file);

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
            None => match sha256_file_from_disk(&part_path).await {
                Ok(digest) => digest,
                Err(err) => {
                    let _ = tokio::fs::remove_file(&part_path).await;
                    set_job_error(
                        &state,
                        &job_id,
                        &tx,
                        &format!("Could not verify download integrity: {err}. Part file removed."),
                    );
                    return;
                }
            },
        };
        if let Err(message) =
            compare_download_hashes(&actual, sha256.as_deref(), linked_etag.as_deref())
        {
            let _ = tokio::fs::remove_file(&part_path).await;
            set_job_error(
                &state,
                &job_id,
                &tx,
                &format!("{message}. Part file removed."),
            );
            return;
        }
    }

    // Rename .part → dest.
    if let Err(err) = tokio::fs::rename(&part_path, &dest).await {
        set_job_error(
            &state,
            &job_id,
            &tx,
            &format!("Could not finalize file: {err}"),
        );
        return;
    }

    // Mark as ready.
    update_job_status(&state, &job_id, &tx, "ready", received, total, None);
}

/// Compute the SHA-256 of a file by streaming it from disk in 1 MiB chunks.
/// Used to verify resumed downloads, where the already-downloaded bytes never
/// pass through the in-memory streaming hasher.
async fn sha256_file_from_disk(path: &std::path::Path) -> Result<String, std::io::Error> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buf).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
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
) -> Result<RemoteDownloadMetadata, reqwest::Error> {
    let response = client.head(url).send().await?;
    let mut linked_etag = linked_etag_from_headers(response.headers());
    if linked_etag.is_none() {
        linked_etag = fetch_hf_linked_etag(url).await.ok().flatten();
    }
    Ok(RemoteDownloadMetadata {
        total: content_length_from_headers(response.headers()),
        linked_etag,
    })
}

async fn fetch_hf_linked_etag(url: &str) -> Result<Option<String>, reqwest::Error> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Lunery Lab Desktop/1.0")
        .build()?;
    let response = client.head(url).send().await?;
    Ok(linked_etag_from_headers(response.headers()))
}

fn compare_download_hashes(
    actual: &str,
    sha256: Option<&str>,
    linked_etag: Option<&str>,
) -> Result<(), String> {
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

pub(crate) fn update_job_status(
    state: &Arc<DownloadState>,
    job_id: &str,
    tx: &tokio::sync::broadcast::Sender<JobSnapshot>,
    status: &str,
    received: u64,
    total: u64,
    error: Option<String>,
) {
    let snapshot = JobSnapshot {
        status: status.to_string(),
        received,
        total,
        error: error.clone(),
    };
    if let Ok(mut guard) = state.0.lock() {
        if let Some(job) = guard.get_mut(job_id) {
            job.status = status.to_string();
            job.received = received;
            job.total = total;
            job.error = error;
        }
    }
    // Broadcast — ignore send errors (no active SSE subscriber is fine).
    let _ = tx.send(snapshot);
}

pub(crate) fn set_job_error(
    state: &Arc<DownloadState>,
    job_id: &str,
    tx: &tokio::sync::broadcast::Sender<JobSnapshot>,
    message: &str,
) {
    update_job_status(state, job_id, tx, "error", 0, 0, Some(message.to_string()));
}

/// Tauri command wrapper for starting a download (direct IPC path).
#[tauri::command]
pub(crate) async fn hf_download_start(
    url: String,
    dest: String,
    sha256: Option<String>,
    job_id: String,
    state: State<'_, Arc<DownloadState>>,
) -> Result<(), String> {
    hf_download_start_inner(url, dest, sha256, job_id, Arc::clone(&state))
}

#[tauri::command]
pub(crate) fn hf_download_cancel(job_id: String, state: State<'_, Arc<DownloadState>>) {
    if let Ok(guard) = state.0.lock() {
        if let Some(job) = guard.get(&job_id) {
            job.cancel.store(true, Ordering::Relaxed);
        }
    }
}

#[tauri::command]
pub(crate) fn hf_download_status(
    job_id: String,
    state: State<'_, Arc<DownloadState>>,
) -> serde_json::Value {
    state
        .0
        .lock()
        .ok()
        .and_then(|guard| {
            guard
                .get(&job_id)
                .map(|job| serde_json::to_value(job.snapshot()).ok())
        })
        .flatten()
        .unwrap_or_else(
            || serde_json::json!({ "status": "unknown", "received": 0, "total": 0, "error": null }),
        )
}

#[tauri::command]
pub(crate) fn hf_download_list(state: State<'_, Arc<DownloadState>>) -> serde_json::Value {
    let jobs: Vec<serde_json::Value> = state
        .0
        .lock()
        .map(|guard| {
            guard
                .iter()
                .map(|(id, job)| {
                    serde_json::json!({
                        "jobId": id,
                        "status": job.status,
                        "received": job.received,
                        "total": job.total,
                        "error": job.error,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    serde_json::json!({ "jobs": jobs })
}

#[cfg(test)]
mod tests {
    use super::{
        classify_partial_download, linked_etag_from_headers, parse_content_range_total,
        run_download_task, sha256_file_from_disk, validate_hf_download_dest, DownloadJob,
        DownloadState, PartialDownloadState,
    };
    use crate::test_global_lock;
    use reqwest::header::{HeaderMap, HeaderValue};
    use std::ffi::OsString;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_path(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        std::env::temp_dir().join(format!("lunerylab-{name}-{nonce}"))
    }

    fn restore_env(name: &str, value: Option<OsString>) {
        if let Some(value) = value {
            std::env::set_var(name, value);
        } else {
            std::env::remove_var(name);
        }
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
        let cancel = Arc::new(AtomicBool::new(false));
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
                    cancel: Arc::clone(&cancel),
                    tx: tx.clone(),
                },
            );
        }

        run_download_task(
            "https://huggingface.co/org/repo/resolve/main/model.gguf".to_string(),
            dest_path.to_string_lossy().to_string(),
            part_path.clone(),
            Some(sha),
            job_id.clone(),
            Arc::clone(&state),
            tx,
            cancel,
        )
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
    async fn stream_error_keeps_partial_file_for_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("read test server address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept test request");
            let mut buffer = [0u8; 1024];
            let _ = stream.read(&mut buffer);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\npartial")
                .expect("write truncated response");
        });

        let dest_path = unique_test_path("stream-error.bin");
        let part_path = std::path::PathBuf::from(format!("{}.part", dest_path.to_string_lossy()));
        let state = Arc::new(DownloadState::default());
        let (tx, _) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(AtomicBool::new(false));
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
                    cancel: Arc::clone(&cancel),
                    tx: tx.clone(),
                },
            );
        }

        run_download_task(
            format!("http://{addr}/model.bin"),
            dest_path.to_string_lossy().to_string(),
            part_path.clone(),
            None,
            job_id.clone(),
            Arc::clone(&state),
            tx,
            cancel,
        )
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
}
