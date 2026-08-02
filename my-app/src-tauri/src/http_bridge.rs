use serde::Deserialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::download::{
    canonical_download_destination, hf_download_start_inner, DownloadCancelRequest, DownloadState,
    JobSnapshot,
};
use crate::engine_llama::{
    acquire_llama_model_delete_lease, bridge_start_llama, bridge_stop_llama, llama_engine_slot,
    release_llama_model_delete_lease, renew_llama_model_delete_lease,
};
use crate::engine_mlx::{
    bridge_start_mlx, bridge_stop_mlx, mlx_engine_slot, mlx_job_slot, mlx_progress_slot,
};
use crate::engine_sd::{
    acquire_sd_model_delete_lease, bridge_cancel_sd, bridge_finish_sd, bridge_sd_generate,
    bridge_stop_sd_if_model_path, release_sd_model_delete_lease, renew_sd_model_delete_lease,
    sd_active_model_path, sd_binary_path, sd_progress_for_run, valid_sd_run_id, SdGenerateBody,
    SdProgressPhase,
};
use crate::external_apps::launch_external_app;
use crate::hardware::{detect_hardware, probe_local_runtime};
use crate::profile_fs::{execute_profile_fs, ProfileFsEnvelope};
use crate::secrets::{
    audit_secret_read, delete_provider_secret, get_provider_secret, save_provider_secret,
    ProviderIdPayload, ProviderSecretMutationError, ProviderSecretPayload, ProviderSecretReadError,
};
use crate::security::{bridge_token, constant_time_eq, host_is_loopback};
use crate::{DesktopBridge, DESKTOP_WORKSPACE_RESET_CONFIRMATION};

pub(crate) type WorkspaceResetHandler = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

/// Pre-auth connection admission. Bounds accepted sockets before token checks.
const BRIDGE_MAX_CONNECTIONS: usize = 24;
/// Long lane: SSE download events + synchronous SD generation.
const BRIDGE_MAX_LONG: usize = 8;
/// Control lane: status, cancel, secrets, stop, lease, reset, and other short ops.
const BRIDGE_MAX_CONTROL: usize = 8;
const PROFILE_FS_RESULT_CACHE_LIMIT: usize = 1024;

#[derive(Default)]
struct ProfileFsResultCache {
    results: HashMap<String, Result<(), String>>,
    order: VecDeque<String>,
}

impl ProfileFsResultCache {
    fn execute(&mut self, envelope: ProfileFsEnvelope) -> Result<(), String> {
        if !valid_profile_fs_request_id(&envelope.request_id) {
            return Err("Invalid profile filesystem request id".to_string());
        }
        if let Some(result) = self.results.get(&envelope.request_id) {
            return result.clone();
        }

        // Hold the cache mutex through execution. A retry that arrives before
        // the first response is written waits here, then observes the stored
        // result instead of executing the mutation twice.
        let result = execute_profile_fs(envelope.request);
        while self.results.len() >= PROFILE_FS_RESULT_CACHE_LIMIT {
            if let Some(expired) = self.order.pop_front() {
                self.results.remove(&expired);
            } else {
                break;
            }
        }
        self.order.push_back(envelope.request_id.clone());
        self.results.insert(envelope.request_id, result.clone());
        result
    }
}

fn valid_profile_fs_request_id(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BridgeLane {
    Long,
    Control,
}

struct BridgeAdmission {
    connections: AtomicUsize,
    long_ops: AtomicUsize,
    control_ops: AtomicUsize,
    revoked: Arc<AtomicBool>,
    accepted_workers: AtomicUsize,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

impl BridgeAdmission {
    fn new() -> Self {
        Self {
            connections: AtomicUsize::new(0),
            long_ops: AtomicUsize::new(0),
            control_ops: AtomicUsize::new(0),
            revoked: Arc::new(AtomicBool::new(false)),
            accepted_workers: AtomicUsize::new(0),
            workers: Mutex::new(Vec::new()),
        }
    }

    fn is_revoked(&self) -> bool {
        self.revoked.load(Ordering::Acquire)
    }

    fn revoke(&self) {
        self.revoked.store(true, Ordering::Release);
    }

    fn try_admit_connection(&self) -> bool {
        if self.is_revoked() {
            return false;
        }
        let current = self.connections.fetch_add(1, Ordering::AcqRel);
        if current >= BRIDGE_MAX_CONNECTIONS || self.is_revoked() {
            self.connections.fetch_sub(1, Ordering::AcqRel);
            return false;
        }
        true
    }

    fn release_connection(&self) {
        self.connections.fetch_sub(1, Ordering::AcqRel);
    }

    fn try_admit_lane(&self, lane: BridgeLane) -> bool {
        if self.is_revoked() {
            return false;
        }
        let counter = match lane {
            BridgeLane::Long => &self.long_ops,
            BridgeLane::Control => &self.control_ops,
        };
        let limit = match lane {
            BridgeLane::Long => BRIDGE_MAX_LONG,
            BridgeLane::Control => BRIDGE_MAX_CONTROL,
        };
        let current = counter.fetch_add(1, Ordering::AcqRel);
        if current >= limit || self.is_revoked() {
            counter.fetch_sub(1, Ordering::AcqRel);
            return false;
        }
        true
    }

    fn release_lane(&self, lane: BridgeLane) {
        match lane {
            BridgeLane::Long => {
                self.long_ops.fetch_sub(1, Ordering::AcqRel);
            }
            BridgeLane::Control => {
                self.control_ops.fetch_sub(1, Ordering::AcqRel);
            }
        }
    }

    fn begin_worker(&self) {
        self.accepted_workers.fetch_add(1, Ordering::AcqRel);
    }

    fn register_worker_handle(&self, handle: JoinHandle<()>) {
        self.workers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(handle);
    }

    fn worker_finished(&self) {
        self.accepted_workers.fetch_sub(1, Ordering::AcqRel);
    }

    fn drain_workers(&self) {
        let workers = {
            let mut guard = self
                .workers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            std::mem::take(&mut *guard)
        };
        for handle in workers {
            // Never detach an accepted worker. Request reads are timeout-bounded,
            // and long SSE workers poll revocation every 50 ms.
            let _ = handle.join();
        }
        debug_assert_eq!(self.accepted_workers.load(Ordering::Acquire), 0);
    }
}

struct WorkerGuard {
    admission: Arc<BridgeAdmission>,
}

impl WorkerGuard {
    fn new(admission: Arc<BridgeAdmission>) -> Self {
        admission.begin_worker();
        Self { admission }
    }
}

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        self.admission.worker_finished();
        self.admission.release_connection();
    }
}

fn classify_bridge_lane(method: &str, path_only: &str) -> BridgeLane {
    if method == "GET" && path_only.starts_with("/download-events") {
        return BridgeLane::Long;
    }
    if method == "POST" && path_only == "/sd-generate" {
        return BridgeLane::Long;
    }
    BridgeLane::Control
}

struct LaneGuard {
    admission: Arc<BridgeAdmission>,
    lane: BridgeLane,
}

impl Drop for LaneGuard {
    fn drop(&mut self) {
        self.admission.release_lane(self.lane);
    }
}

pub(crate) struct DesktopBridgeServer {
    pub(crate) bridge: DesktopBridge,
    shutdown: Arc<AtomicBool>,
    /// Counts actual stop-body executions (not no-op re-entries). Used to prove
    /// explicit shutdown + Drop is idempotent without racing process-global SD
    /// epoch mutators from unrelated tests.
    stop_body_runs: Arc<AtomicUsize>,
    admission: Arc<BridgeAdmission>,
    download_state: Arc<DownloadState>,
    listener_thread: Option<JoinHandle<()>>,
}

impl DesktopBridgeServer {
    /// Idempotent stop: explicit `shutdown()` plus `Drop` must not advance the
    /// SD runtime epoch twice or double-drain workers.
    fn stop(&mut self) {
        if self.shutdown.swap(true, Ordering::AcqRel) {
            return;
        }
        self.stop_body_runs.fetch_add(1, Ordering::SeqCst);
        // 1) Revoke admission first so new work cannot enter.
        self.admission.revoke();
        // Wake the nonblocking accept loop immediately instead of waiting for
        // its poll interval. No request is sent and the connection is dropped.
        let _ = TcpStream::connect(("127.0.0.1", self.bridge.port));
        // 2) Interrupt / cooperatively terminate long engines so workers exit.
        crate::engine_sd::bridge_stop_sd();
        self.download_state.request_cancel_all_active();
        // 3) Seal the handle registry. The listener is the only producer, so it
        // must be joined before taking and joining the accepted-worker handles.
        if let Some(thread) = self.listener_thread.take() {
            let _ = thread.join();
        }
        // 4) Join every accepted worker. Dropping unfinished JoinHandles would
        // detach post-teardown work and violate the bridge lifetime boundary.
        self.admission.drain_workers();
        // A request accepted just before revoke may have started a background
        // download after the first cancel sweep. Sweep again once all request
        // workers are joined, then wait for every tracked async task to return
        // before reset can delete the model tree or a new bridge can reuse it.
        self.download_state.request_cancel_all_active();
        self.download_state.wait_for_background_tasks();
    }

    pub(crate) fn shutdown(mut self) {
        self.stop();
    }
}

impl Drop for DesktopBridgeServer {
    fn drop(&mut self) {
        self.stop();
    }
}

enum HttpRequestReadError {
    EmptyConnection,
    Invalid,
}

fn read_http_request(
    stream: &mut TcpStream,
) -> Result<(String, String, HashMap<String, String>, String), HttpRequestReadError> {
    // Per-chunk read timeout: short enough that a slow-loris attacker can't
    // hold the socket open by dribbling one byte every few seconds.
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| HttpRequestReadError::Invalid)?;

    // Per-connection envelope: even if each chunk arrives just inside the 2s
    // read timeout, the whole request still has to land within 10s. Anything
    // beyond that is treated as a slow-loris and the connection is torn down.
    const MAX_REQUEST_DURATION: Duration = Duration::from_secs(10);
    let start = Instant::now();

    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let mut header_end = None;
    let mut content_length = 0_usize;
    const MAX_HEADER_BYTES: usize = 64 * 1024;
    const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

    loop {
        if start.elapsed() > MAX_REQUEST_DURATION {
            return Err(HttpRequestReadError::Invalid);
        }
        let read = match stream.read(&mut chunk) {
            Ok(read) => read,
            Err(error)
                if buffer.is_empty()
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
            {
                return Err(HttpRequestReadError::EmptyConnection);
            }
            Err(_) => return Err(HttpRequestReadError::Invalid),
        };
        if read == 0 {
            if buffer.is_empty() {
                return Err(HttpRequestReadError::EmptyConnection);
            }
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);

        if header_end.is_none() {
            if buffer.len() > MAX_HEADER_BYTES {
                return Err(HttpRequestReadError::Invalid);
            }
            if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                header_end = Some(position + 4);
                let headers = String::from_utf8_lossy(&buffer[..position]).to_string();
                for line in headers.lines().skip(1) {
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            content_length = value.trim().parse::<usize>().unwrap_or_default();
                            if content_length >= MAX_BODY_BYTES {
                                return Err(HttpRequestReadError::Invalid);
                            }
                        }
                    }
                }
            }
        }

        if let Some(end) = header_end {
            if buffer.len() >= end + content_length {
                break;
            }
        }
    }

    let end = header_end.ok_or(HttpRequestReadError::Invalid)?;
    let header_text = String::from_utf8_lossy(&buffer[..end]).to_string();
    let body = String::from_utf8_lossy(&buffer[end..]).to_string();
    let mut lines = header_text.lines();
    let request_line = lines.next().ok_or(HttpRequestReadError::Invalid)?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let path = request_parts.next().unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    Ok((method, path, headers, body))
}

fn write_http_response(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn bridge_error(stream: &mut TcpStream, status: &str, message: &str) {
    let body = serde_json::json!({ "error": message }).to_string();
    write_http_response(stream, status, &body);
}

/// Percent-decode a URL query-string value (std-only, non-panicking).
/// `+` is decoded as space; malformed `%XX` sequences are left as-is.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                } else {
                    // Malformed escape — emit literally and advance one byte.
                    out.push(b'%');
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Extract the value of the first occurrence of `key` from a
/// `application/x-www-form-urlencoded` query string (e.g. `"a=1&b=2"`).
fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                let decoded = percent_decode(v);
                return if decoded.is_empty() {
                    None
                } else {
                    Some(decoded)
                };
            }
        }
    }
    None
}

/// Write a single HTTP/1.1 chunked frame.
/// Frame format: `{hex-length}\r\n{data}\r\n`
fn write_chunked_frame(stream: &mut TcpStream, data: &[u8]) -> std::io::Result<()> {
    let hex = format!("{:x}\r\n", data.len());
    stream.write_all(hex.as_bytes())?;
    stream.write_all(data)?;
    stream.write_all(b"\r\n")?;
    Ok(())
}

/// Handle the SSE/chunked streaming path for `/download-events?jobId=...`.
/// Writes a full HTTP response directly onto `stream` and returns when the
/// job terminates or the client disconnects.  All other bridge routes remain
/// untouched (request/response pattern).
fn handle_sse_download_events(
    stream: &mut TcpStream,
    query: &str,
    download_state: &Arc<DownloadState>,
    revoked: &Arc<AtomicBool>,
) {
    let job_id = match query_param(query, "jobId") {
        Some(id) => id,
        None => {
            bridge_error(stream, "400 Bad Request", "Missing jobId query parameter");
            return;
        }
    };

    // Grab a receiver and the initial snapshot under the lock, then release
    // immediately so the download task is never blocked by the SSE drain loop.
    let (rx, initial) = {
        let guard = match download_state.0.lock() {
            Ok(g) => g,
            Err(_) => {
                bridge_error(
                    stream,
                    "500 Internal Server Error",
                    "Download state lock poisoned",
                );
                return;
            }
        };
        match guard.get(&job_id) {
            Some(job) => (job.tx.subscribe(), job.snapshot()),
            None => {
                let body = serde_json::json!({
                    "status": "unknown", "received": 0_u64, "total": 0_u64, "error": null
                })
                .to_string();
                bridge_error(stream, "404 Not Found", &body);
                return;
            }
        }
    };

    // Disable the 2-second read timeout set by read_http_request — SSE connections
    // are long-lived and should only close when the job terminates or client drops.
    let _ = stream.set_read_timeout(None);
    // Bound thread lifetime: if the client disconnects and writes stall, the
    // write_timeout causes the next write_all to fail and the loop returns.
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));

    // Write SSE response headers (chunked transfer encoding).
    let headers = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n";
    if stream.write_all(headers).is_err() {
        return; // client already disconnected
    }

    // Helper: emit one SSE `data:` frame as a chunked HTTP chunk.
    let emit = |stream: &mut TcpStream, snapshot: &JobSnapshot| -> bool {
        let json = match serde_json::to_string(snapshot) {
            Ok(j) => j,
            Err(_) => return false,
        };
        let frame = format!("data: {json}\n\n");
        write_chunked_frame(stream, frame.as_bytes()).is_ok()
    };

    // Send the initial snapshot immediately so the client gets feedback on subscribe.
    let is_terminal = |s: &str| matches!(s, "ready" | "error" | "canceled");
    if !emit(stream, &initial) {
        return;
    }
    if is_terminal(&initial.status) {
        let _ = write_chunked_frame(stream, b""); // chunked terminator
        return;
    }

    // The blocking worker can poll the broadcast receiver directly. This keeps
    // the path bounded: no orphan async forwarder and no unbounded queue when a
    // client stops reading.
    let mut rx = rx;
    loop {
        if revoked.load(Ordering::Acquire) {
            let _ = write_chunked_frame(stream, b"");
            return;
        }
        match rx.try_recv() {
            Ok(snapshot) => {
                if !emit(stream, &snapshot) {
                    return; // client disconnected
                }
                if is_terminal(&snapshot.status) {
                    let _ = write_chunked_frame(stream, b""); // HTTP chunked terminator
                    return;
                }
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => {
                // Sender dropped (download task finished but we may have missed the
                // final snapshot). Grab the latest from state and emit it.
                let guard = download_state.0.lock();
                if let Ok(g) = guard {
                    if let Some(job) = g.get(&job_id) {
                        let snap = job.snapshot();
                        let _ = emit(stream, &snap);
                    }
                }
                let _ = write_chunked_frame(stream, b"");
                return;
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {
                // We fell behind — grab current snapshot from state and continue.
                let guard = download_state.0.lock();
                if let Ok(g) = guard {
                    if let Some(job) = g.get(&job_id) {
                        let snap = job.snapshot();
                        if !emit(stream, &snap) {
                            return;
                        }
                        if is_terminal(&snap.status) {
                            let _ = write_chunked_frame(stream, b"");
                            return;
                        }
                    }
                }
            }
        }
    }
}

fn handle_bridge_request(
    mut stream: TcpStream,
    token: &str,
    download_state: Arc<DownloadState>,
    workspace_reset: WorkspaceResetHandler,
    profile_fs_results: Arc<Mutex<ProfileFsResultCache>>,
    admission: Arc<BridgeAdmission>,
) {
    let (method, path, headers, body) = match read_http_request(&mut stream) {
        Ok(request) => request,
        Err(HttpRequestReadError::EmptyConnection) => return,
        Err(HttpRequestReadError::Invalid) => {
            bridge_error(&mut stream, "400 Bad Request", "Invalid request");
            return;
        }
    };

    if admission.is_revoked() {
        bridge_error(
            &mut stream,
            "503 Service Unavailable",
            "Desktop bridge is shutting down",
        );
        return;
    }

    // Constant-time token check — avoids leaking the token via the timing of a
    // short-circuiting `!=` byte comparison. A missing header is rejected the
    // same as a wrong one.
    let token_ok = match headers.get("x-lunery-desktop-token") {
        Some(v) => constant_time_eq(v.as_bytes(), token.as_bytes()),
        None => false,
    };
    if !token_ok {
        bridge_error(
            &mut stream,
            "401 Unauthorized",
            "Invalid desktop bridge token",
        );
        return;
    }

    // Defense-in-depth Host check (anti DNS-rebinding). Headers are stored
    // lowercased by read_http_request, so look up "host". If a Host header is
    // present it MUST resolve to loopback; absent Host is tolerated (some
    // legitimate clients omit it). The Next server calls with the loopback URL,
    // so its Host is always `127.0.0.1:<port>` and passes.
    if let Some(host) = headers.get("host") {
        if !host_is_loopback(host) {
            bridge_error(
                &mut stream,
                "403 Forbidden",
                "Desktop bridge only accepts loopback Host",
            );
            return;
        }
    }

    // Strip query string so route matching works regardless of query parameters.
    let (path_only, query) = path
        .split_once('?')
        .map_or((path.as_str(), ""), |(p, q)| (p, q));

    let lane = classify_bridge_lane(method.as_str(), path_only);
    if !admission.try_admit_lane(lane) {
        bridge_error(
            &mut stream,
            "429 Too Many Requests",
            "Desktop bridge lane is at capacity; retry after current jobs settle.",
        );
        return;
    }
    let _lane_guard = LaneGuard {
        admission: Arc::clone(&admission),
        lane,
    };
    if admission.is_revoked() {
        bridge_error(
            &mut stream,
            "503 Service Unavailable",
            "Desktop bridge is shutting down",
        );
        return;
    }

    // SSE path — handled separately, writes the full HTTP response itself and returns.
    // Must come BEFORE the match to avoid falling through to the standard responder.
    if method == "GET" && path_only.starts_with("/download-events") {
        handle_sse_download_events(&mut stream, query, &download_state, &admission.revoked);
        return;
    }

    match (method.as_str(), path_only) {
        ("GET", "/status") => match serde_json::to_string(&crate::desktop_runtime_status()) {
            Ok(payload) => write_http_response(&mut stream, "200 OK", &payload),
            Err(err) => bridge_error(&mut stream, "500 Internal Server Error", &err.to_string()),
        },
        ("POST", "/profile-fs") => {
            match serde_json::from_str::<ProfileFsEnvelope>(&body)
                .map_err(|error| error.to_string())
                .and_then(|envelope| {
                    profile_fs_results
                        .lock()
                        .map_err(|_| "Profile filesystem result cache is poisoned".to_string())?
                        .execute(envelope)
                }) {
                Ok(()) => write_http_response(
                    &mut stream,
                    "200 OK",
                    &serde_json::json!({ "ok": true }).to_string(),
                ),
                Err(error) => bridge_error(&mut stream, "409 Conflict", &error),
            }
        }
        ("POST", "/reset-workspace") => {
            #[derive(Deserialize)]
            struct ResetWorkspaceBody {
                confirmation: String,
            }

            match serde_json::from_str::<ResetWorkspaceBody>(&body) {
                Ok(request) if request.confirmation == DESKTOP_WORKSPACE_RESET_CONFIRMATION => {
                    match workspace_reset() {
                        Ok(()) => write_http_response(
                            &mut stream,
                            "202 Accepted",
                            &serde_json::json!({ "resetting": true }).to_string(),
                        ),
                        Err(err) => bridge_error(&mut stream, "409 Conflict", &err),
                    }
                }
                _ => bridge_error(
                    &mut stream,
                    "400 Bad Request",
                    "Explicit workspace reset confirmation is required",
                ),
            }
        }
        ("POST", "/provider-secret") => {
            let payload = match serde_json::from_str::<ProviderSecretPayload>(&body) {
                Ok(payload) => payload,
                Err(_) => {
                    bridge_error(
                        &mut stream,
                        "400 Bad Request",
                        "Invalid provider secret request",
                    );
                    return;
                }
            };
            match save_provider_secret(payload) {
                Ok(status) => match serde_json::to_string(&status) {
                    Ok(payload) => write_http_response(&mut stream, "200 OK", &payload),
                    Err(_) => bridge_error(
                        &mut stream,
                        "500 Internal Server Error",
                        "Could not encode provider secret status",
                    ),
                },
                Err(error) => bridge_error(
                    &mut stream,
                    provider_secret_mutation_http_status(error),
                    error.public_message(),
                ),
            }
        }
        ("DELETE", "/provider-secret") => {
            let payload = match serde_json::from_str::<ProviderIdPayload>(&body) {
                Ok(payload) => payload,
                Err(_) => {
                    bridge_error(
                        &mut stream,
                        "400 Bad Request",
                        "Invalid provider secret request",
                    );
                    return;
                }
            };
            match delete_provider_secret(payload) {
                Ok(status) => match serde_json::to_string(&status) {
                    Ok(payload) => write_http_response(&mut stream, "200 OK", &payload),
                    Err(_) => bridge_error(
                        &mut stream,
                        "500 Internal Server Error",
                        "Could not encode provider secret status",
                    ),
                },
                Err(error) => bridge_error(
                    &mut stream,
                    provider_secret_mutation_http_status(error),
                    error.public_message(),
                ),
            }
        }
        ("POST", "/provider-secret-read") => {
            // SECURITY: the returned key is never logged anywhere in this
            // handler. Audit logs record the attempt + outcome only.
            //
            // Positive cache + same-provider single-flight keep repeated reads
            // of a configured provider free. Every positive-cache miss that
            // will perform a real OS-keychain read consumes the global
            // 5/minute limiter before the backend call.
            let payload = match serde_json::from_str::<ProviderIdPayload>(&body) {
                Ok(payload) => payload,
                Err(_) => {
                    audit_secret_read("unknown", false, "invalid_request");
                    bridge_error(
                        &mut stream,
                        "400 Bad Request",
                        "Invalid secret-read request",
                    );
                    return;
                }
            };
            let provider_id = payload.provider_id.clone();
            match get_provider_secret(payload) {
                Ok(key) => {
                    audit_secret_read(&provider_id, true, "ok");
                    match serde_json::to_string(&serde_json::json!({ "key": key })) {
                        Ok(payload) => write_http_response(&mut stream, "200 OK", &payload),
                        Err(_) => bridge_error(
                            &mut stream,
                            "500 Internal Server Error",
                            "Could not serialize secret response",
                        ),
                    }
                }
                Err(error) => {
                    audit_secret_read(&provider_id, false, error.audit_reason());
                    let status = match error {
                        ProviderSecretReadError::InvalidProvider => "400 Bad Request",
                        ProviderSecretReadError::Missing => "404 Not Found",
                        ProviderSecretReadError::Unavailable => "503 Service Unavailable",
                        ProviderSecretReadError::RateLimited => "429 Too Many Requests",
                    };
                    bridge_error(&mut stream, status, error.public_message());
                }
            }
        }
        ("GET", "/hardware") => {
            let model_dir = query_param(query, "modelDir");
            match serde_json::to_string(&detect_hardware(model_dir)) {
                Ok(payload) => write_http_response(&mut stream, "200 OK", &payload),
                Err(err) => {
                    bridge_error(&mut stream, "500 Internal Server Error", &err.to_string())
                }
            }
        }
        ("POST", "/runtime-probe") => {
            #[derive(Deserialize)]
            struct ProbeBody {
                endpoint: String,
            }
            match serde_json::from_str::<ProbeBody>(&body)
                .map_err(|err| err.to_string())
                .and_then(|probe| {
                    serde_json::to_string(&probe_local_runtime(probe.endpoint))
                        .map_err(|err| err.to_string())
                }) {
                Ok(payload) => write_http_response(&mut stream, "200 OK", &payload),
                Err(err) => bridge_error(&mut stream, "400 Bad Request", &err),
            }
        }
        // Download commands — proxied from Next API routes via the bridge.
        ("POST", "/hf-download-start") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct StartBody {
                url: String,
                dest: String,
                sha256: Option<String>,
                job_id: String,
            }
            match serde_json::from_str::<StartBody>(&body) {
                Ok(start) => {
                    let state = Arc::clone(&download_state);
                    let job_id = start.job_id.clone();
                    match hf_download_start_inner(
                        start.url,
                        start.dest,
                        start.sha256,
                        start.job_id,
                        state,
                    ) {
                        Ok(()) => write_http_response(
                            &mut stream,
                            "200 OK",
                            &serde_json::json!({ "ok": true, "jobId": job_id }).to_string(),
                        ),
                        Err(err) if err.contains("conflicts with a different") => {
                            bridge_error(&mut stream, "409 Conflict", &err)
                        }
                        Err(err) => bridge_error(&mut stream, "400 Bad Request", &err),
                    }
                }
                Err(err) => bridge_error(&mut stream, "400 Bad Request", &err.to_string()),
            }
        }
        ("POST", "/hf-download-cancel") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct CancelBody {
                job_id: String,
            }
            match serde_json::from_str::<CancelBody>(&body) {
                Ok(cancel) => match download_state.request_cancel_job(&cancel.job_id) {
                    outcome @ (DownloadCancelRequest::Accepted | DownloadCancelRequest::Pending) => write_http_response(
                        &mut stream,
                        "202 Accepted",
                        &serde_json::json!({
                            "ok": true,
                            "cancelRequested": true,
                            "jobId": cancel.job_id,
                            "pendingReservation": matches!(outcome, DownloadCancelRequest::Pending),
                        })
                        .to_string(),
                    ),
                    DownloadCancelRequest::NotFound => {
                        bridge_error(&mut stream, "404 Not Found", "Download job not found")
                    }
                    DownloadCancelRequest::Terminal => bridge_error(
                        &mut stream,
                        "409 Conflict",
                        "Download job is already terminal",
                    ),
                },
                Err(err) => bridge_error(&mut stream, "400 Bad Request", &err.to_string()),
            }
        }
        ("GET", "/hf-download-status") => {
            let job_id = query_param(query, "jobId").unwrap_or_default();
            let snapshot = download_state
                .0
                .lock()
                .ok()
                .and_then(|guard| guard.get(&job_id).map(|job| job.snapshot()));
            let payload = match snapshot {
                Some(snap) => serde_json::to_string(&snap).unwrap_or_else(|_| {
                    r#"{"status":"error","received":0,"total":0,"error":"serialize"}"#.to_string()
                }),
                None => serde_json::json!({
                    "status": "unknown", "received": 0_u64, "total": 0_u64, "error": null
                })
                .to_string(),
            };
            write_http_response(&mut stream, "200 OK", &payload);
        }
        ("GET", "/hf-download-list") => {
            let list: Vec<serde_json::Value> = download_state
                .0
                .lock()
                .map(|guard| {
                    guard
                        .iter()
                        .map(|(id, job)| {
                            serde_json::json!({
                                "jobId": id,
                                "status": job.status,
                                "destination": job.destination,
                                "received": job.received,
                                "total": job.total,
                                "error": job.error,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let payload = serde_json::json!({ "jobs": list }).to_string();
            write_http_response(&mut stream, "200 OK", &payload);
        }
        ("POST", "/hf-download-delete-lease-acquire") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct LeaseBody {
                lease_id: String,
                destinations: Vec<String>,
                #[serde(default)]
                renew: bool,
            }
            let result = serde_json::from_str::<LeaseBody>(&body)
                .map_err(|error| error.to_string())
                .and_then(|lease| {
                    if lease.lease_id.is_empty()
                        || lease.lease_id.len() > 128
                        || lease.destinations.is_empty()
                        || lease.destinations.len() > 16
                    {
                        return Err("Invalid model deletion lease".to_string());
                    }
                    let destinations = lease
                        .destinations
                        .iter()
                        .map(|value| canonical_download_destination(value))
                        .collect::<Result<Vec<_>, _>>()?;
                    let mut acquired: Vec<std::path::PathBuf> = Vec::new();
                    for destination in destinations {
                        let result = if lease.renew {
                            download_state.renew_destination_delete_lease(
                                destination.clone(),
                                &lease.lease_id,
                            )
                        } else {
                            download_state.acquire_destination_delete_lease(
                                destination.clone(),
                                &lease.lease_id,
                            )
                        };
                        if let Err(error) = result {
                            for prior in &acquired {
                                download_state
                                    .release_destination_delete_lease(prior, &lease.lease_id);
                            }
                            return Err(error);
                        }
                        acquired.push(destination);
                    }
                    Ok(())
                });
            match result {
                Ok(()) => write_http_response(
                    &mut stream,
                    "200 OK",
                    &serde_json::json!({ "acquired": true }).to_string(),
                ),
                Err(error) => bridge_error(&mut stream, "409 Conflict", &error),
            }
        }
        ("POST", "/hf-download-delete-lease-release") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct LeaseBody {
                lease_id: String,
                destinations: Vec<String>,
            }
            match serde_json::from_str::<LeaseBody>(&body) {
                Ok(lease) => {
                    for destination in lease
                        .destinations
                        .iter()
                        .filter_map(|value| canonical_download_destination(value).ok())
                    {
                        download_state
                            .release_destination_delete_lease(&destination, &lease.lease_id);
                    }
                    write_http_response(
                        &mut stream,
                        "200 OK",
                        &serde_json::json!({ "released": true }).to_string(),
                    );
                }
                Err(error) => bridge_error(&mut stream, "400 Bad Request", &error.to_string()),
            }
        }
        ("POST", "/llama-start") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct StartBody {
                model_path: String,
                model_id: String,
            }
            match serde_json::from_str::<StartBody>(&body)
                .map_err(|e| e.to_string())
                .and_then(|b| bridge_start_llama(b.model_path, b.model_id))
                .and_then(|s| serde_json::to_string(&s).map_err(|e| e.to_string()))
            {
                Ok(payload) => write_http_response(&mut stream, "200 OK", &payload),
                Err(err) => bridge_error(&mut stream, "400 Bad Request", &err),
            }
        }
        ("POST", "/llama-stop") => {
            bridge_stop_llama();
            write_http_response(
                &mut stream,
                "200 OK",
                &serde_json::json!({ "ok": true }).to_string(),
            );
        }
        ("GET", "/llama-status") => {
            let info = llama_engine_slot().lock().ok().and_then(|g| g.clone());
            let payload = serde_json::json!({
                "running": info.is_some(),
                "endpoint": info.as_ref().map(|e| e.endpoint.clone()),
                "modelPath": info.as_ref().map(|e| e.model_path.clone()),
                "modelId": info.as_ref().map(|e| e.model_id.clone()),
            })
            .to_string();
            write_http_response(&mut stream, "200 OK", &payload);
        }
        ("POST", "/llama-delete-lease-acquire") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct LeaseBody {
                lease_id: String,
                model_path: String,
                #[serde(default)]
                renew: bool,
            }
            match serde_json::from_str::<LeaseBody>(&body)
                .map_err(|error| error.to_string())
                .and_then(|lease| {
                    if lease.renew {
                        renew_llama_model_delete_lease(&lease.model_path, &lease.lease_id)
                    } else {
                        acquire_llama_model_delete_lease(&lease.model_path, &lease.lease_id)
                    }
                }) {
                Ok(()) => write_http_response(
                    &mut stream,
                    "200 OK",
                    &serde_json::json!({ "acquired": true }).to_string(),
                ),
                Err(error) => bridge_error(&mut stream, "409 Conflict", &error),
            }
        }
        ("POST", "/llama-delete-lease-release") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct LeaseBody {
                lease_id: String,
                model_path: String,
            }
            match serde_json::from_str::<LeaseBody>(&body) {
                Ok(lease) => {
                    release_llama_model_delete_lease(&lease.model_path, &lease.lease_id);
                    write_http_response(
                        &mut stream,
                        "200 OK",
                        &serde_json::json!({ "released": true }).to_string(),
                    );
                }
                Err(error) => bridge_error(&mut stream, "400 Bad Request", &error.to_string()),
            }
        }
        ("POST", "/sd-generate") => {
            match serde_json::from_str::<SdGenerateBody>(&body)
                .map_err(|e| e.to_string())
                .and_then(bridge_sd_generate)
                .and_then(|r| {
                    serde_json::to_string(&serde_json::json!({ "results": r }))
                        .map_err(|e| e.to_string())
                }) {
                Ok(payload) => write_http_response(&mut stream, "200 OK", &payload),
                Err(err) => bridge_error(&mut stream, "400 Bad Request", &err),
            }
        }
        ("POST", "/sd-delete-lease-acquire") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct LeaseBody {
                lease_id: String,
                model_path: String,
                #[serde(default)]
                renew: bool,
            }
            match serde_json::from_str::<LeaseBody>(&body)
                .map_err(|error| error.to_string())
                .and_then(|lease| {
                    if lease.renew {
                        renew_sd_model_delete_lease(&lease.model_path, &lease.lease_id)
                    } else {
                        acquire_sd_model_delete_lease(&lease.model_path, &lease.lease_id)
                    }
                }) {
                Ok(()) => write_http_response(
                    &mut stream,
                    "200 OK",
                    &serde_json::json!({ "acquired": true }).to_string(),
                ),
                Err(error) => bridge_error(&mut stream, "409 Conflict", &error),
            }
        }
        ("POST", "/sd-delete-lease-release") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct LeaseBody {
                lease_id: String,
                model_path: String,
            }
            match serde_json::from_str::<LeaseBody>(&body) {
                Ok(lease) => {
                    release_sd_model_delete_lease(&lease.model_path, &lease.lease_id);
                    write_http_response(
                        &mut stream,
                        "200 OK",
                        &serde_json::json!({ "released": true }).to_string(),
                    );
                }
                Err(error) => bridge_error(&mut stream, "400 Bad Request", &error.to_string()),
            }
        }
        ("GET", "/sd-status") => {
            let available = sd_binary_path().is_some();
            let model_path = sd_active_model_path();
            let payload = serde_json::json!({
                "available": available,
                "engine": "stable-diffusion.cpp",
                "running": model_path.is_some(),
                "modelPath": model_path,
            })
            .to_string();
            write_http_response(&mut stream, "200 OK", &payload);
        }
        ("POST", "/sd-stop") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct StopBody {
                model_path: String,
            }
            match serde_json::from_str::<StopBody>(&body) {
                Ok(stop) => {
                    let stopped = bridge_stop_sd_if_model_path(&stop.model_path);
                    write_http_response(
                        &mut stream,
                        "200 OK",
                        &serde_json::json!({ "ok": true, "stopped": stopped }).to_string(),
                    );
                }
                Err(err) => bridge_error(&mut stream, "400 Bad Request", &err.to_string()),
            }
        }
        ("GET", "/sd-progress") => {
            let Some(run_id) = query_param(query, "runId").filter(|run_id| valid_sd_run_id(run_id))
            else {
                bridge_error(&mut stream, "400 Bad Request", "Missing or invalid runId");
                return;
            };
            let payload = serde_json::json!({
                "progress": sd_progress_for_run(&run_id),
            })
            .to_string();
            write_http_response(&mut stream, "200 OK", &payload);
        }
        ("POST", "/sd-cancel") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct CancelBody {
                run_id: String,
            }
            match serde_json::from_str::<CancelBody>(&body) {
                Ok(cancel) if valid_sd_run_id(&cancel.run_id) => {
                    let canceled = bridge_cancel_sd(&cancel.run_id);
                    write_http_response(
                        &mut stream,
                        "200 OK",
                        &serde_json::json!({ "canceled": canceled }).to_string(),
                    );
                }
                _ => bridge_error(&mut stream, "400 Bad Request", "Missing or invalid runId"),
            }
        }
        ("POST", "/sd-progress-finish") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct FinishBody {
                run_id: String,
                phase: String,
            }
            match serde_json::from_str::<FinishBody>(&body) {
                Ok(finish) if valid_sd_run_id(&finish.run_id) => {
                    let phase = match finish.phase.as_str() {
                        "completed" => Some(SdProgressPhase::Completed),
                        "canceled" => Some(SdProgressPhase::Canceled),
                        "failed" => Some(SdProgressPhase::Failed),
                        _ => None,
                    };
                    if let Some(phase) = phase {
                        let updated = bridge_finish_sd(&finish.run_id, phase);
                        write_http_response(
                            &mut stream,
                            "200 OK",
                            &serde_json::json!({ "updated": updated }).to_string(),
                        );
                    } else {
                        bridge_error(&mut stream, "400 Bad Request", "Invalid terminal phase");
                    }
                }
                _ => bridge_error(&mut stream, "400 Bad Request", "Missing or invalid runId"),
            }
        }
        ("POST", "/mlx-start") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct StartBody {
                model: String,
            }
            match serde_json::from_str::<StartBody>(&body)
                .map_err(|e| e.to_string())
                .and_then(|b| bridge_start_mlx(b.model))
                .and_then(|s| serde_json::to_string(&s).map_err(|e| e.to_string()))
            {
                Ok(payload) => write_http_response(&mut stream, "200 OK", &payload),
                Err(err) => bridge_error(&mut stream, "400 Bad Request", &err),
            }
        }
        ("POST", "/mlx-stop") => {
            bridge_stop_mlx();
            write_http_response(
                &mut stream,
                "200 OK",
                &serde_json::json!({ "ok": true }).to_string(),
            );
        }
        ("GET", "/mlx-status") => {
            let info = mlx_engine_slot().lock().ok().and_then(|g| g.clone());
            let prog = mlx_progress_slot().lock().ok().and_then(|g| g.clone());
            let job = mlx_job_slot().lock().ok().and_then(|g| g.clone());
            let payload = serde_json::json!({
                "running": info.is_some(),
                "endpoint": info.as_ref().map(|e| e.endpoint.clone()),
                "model": info.as_ref().map(|e| e.model.clone()),
                "jobId": job.as_ref().map(|j| j.job_id.clone()),
                "phase": if info.is_some() {
                    Some("ready".to_string())
                } else {
                    job.as_ref().map(|j| j.phase.clone())
                        .or_else(|| prog.as_ref().map(|p| p.phase.clone()))
                },
                "percent": if info.is_some() {
                    Some(100u8)
                } else {
                    job.as_ref().and_then(|j| j.percent)
                        .or_else(|| prog.as_ref().and_then(|p| p.percent))
                },
                "error": job.as_ref().and_then(|j| j.error.clone()),
            })
            .to_string();
            write_http_response(&mut stream, "200 OK", &payload);
        }
        ("POST", "/launch-external-app") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct LaunchBody {
                app_id: String,
            }
            match serde_json::from_str::<LaunchBody>(&body)
                .map_err(|e| e.to_string())
                .and_then(|b| launch_external_app(&b.app_id))
            {
                Ok(()) => write_http_response(
                    &mut stream,
                    "200 OK",
                    &serde_json::json!({ "ok": true }).to_string(),
                ),
                Err(err) => bridge_error(&mut stream, "400 Bad Request", &err),
            }
        }
        _ => bridge_error(&mut stream, "404 Not Found", "Unknown desktop bridge route"),
    }
}

fn provider_secret_mutation_http_status(error: ProviderSecretMutationError) -> &'static str {
    match error {
        ProviderSecretMutationError::InvalidProvider
        | ProviderSecretMutationError::InvalidSecret => "400 Bad Request",
        ProviderSecretMutationError::Unavailable => "503 Service Unavailable",
    }
}

pub(crate) fn start_desktop_bridge(
    download_state: Arc<DownloadState>,
    workspace_reset: WorkspaceResetHandler,
) -> Result<DesktopBridgeServer, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("Could not start desktop bridge: {err}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|err| format!("Could not configure desktop bridge: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Could not inspect desktop bridge port: {err}"))?
        .port();
    let token = bridge_token()?;
    let bridge_token = token.clone();
    let admission = Arc::new(BridgeAdmission::new());
    let shutdown = Arc::new(AtomicBool::new(false));
    let listener_shutdown = Arc::clone(&shutdown);
    let listener_admission = Arc::clone(&admission);

    let listener_download_state = Arc::clone(&download_state);
    let profile_fs_results = Arc::new(Mutex::new(ProfileFsResultCache::default()));
    let listener_profile_fs_results = Arc::clone(&profile_fs_results);
    let listener_thread = thread::spawn(move || {
        while !listener_shutdown.load(Ordering::Acquire) && !listener_admission.is_revoked() {
            let mut stream = match listener.accept() {
                Ok((stream, _)) => stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(25));
                    continue;
                }
                Err(_) => break,
            };
            if listener_shutdown.load(Ordering::Acquire) || listener_admission.is_revoked() {
                break;
            }
            if !listener_admission.try_admit_connection() {
                bridge_error(
                    &mut stream,
                    "429 Too Many Requests",
                    "Desktop bridge is at capacity; retry after current jobs settle.",
                );
                continue;
            }
            let token = bridge_token.clone();
            let ds = Arc::clone(&listener_download_state);
            let reset = Arc::clone(&workspace_reset);
            let profile_fs_results = Arc::clone(&listener_profile_fs_results);
            let admission_for_worker = Arc::clone(&listener_admission);
            let worker = thread::Builder::new().spawn(move || {
                let _worker_guard = WorkerGuard::new(Arc::clone(&admission_for_worker));
                handle_bridge_request(
                    stream,
                    &token,
                    ds,
                    reset,
                    profile_fs_results,
                    Arc::clone(&admission_for_worker),
                );
            });
            match worker {
                Ok(handle) => listener_admission.register_worker_handle(handle),
                Err(_) => listener_admission.release_connection(),
            }
        }
    });

    Ok(DesktopBridgeServer {
        bridge: DesktopBridge { port, token },
        shutdown,
        stop_body_runs: Arc::new(AtomicUsize::new(0)),
        admission,
        download_state,
        listener_thread: Some(listener_thread),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        classify_bridge_lane, provider_secret_mutation_http_status, start_desktop_bridge,
        BridgeAdmission, BridgeLane, ProfileFsResultCache, ProviderSecretMutationError,
        WorkspaceResetHandler, BRIDGE_MAX_CONTROL, BRIDGE_MAX_LONG,
    };
    use crate::download::{
        auxiliary_head_for_shutdown_test, update_job_status, DownloadCancel, DownloadJob,
        DownloadState, JobSnapshot,
    };
    use crate::profile_fs::{ProfileFsEnvelope, ProfileFsRequest, ProfileFsRoot};
    use crate::test_global_lock;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn provider_secret_validation_errors_map_to_bad_request() {
        assert_eq!(
            provider_secret_mutation_http_status(ProviderSecretMutationError::InvalidProvider),
            "400 Bad Request"
        );
        assert_eq!(
            provider_secret_mutation_http_status(ProviderSecretMutationError::InvalidSecret),
            "400 Bad Request"
        );
    }

    #[test]
    fn provider_secret_store_outages_map_to_service_unavailable() {
        assert_eq!(
            provider_secret_mutation_http_status(ProviderSecretMutationError::Unavailable),
            "503 Service Unavailable"
        );
    }

    #[test]
    fn bridge_shutdown_revokes_the_previous_listener() {
        // Shutdown advances the SD runtime epoch / cancel flag; serialize with
        // engine_sd tests that share those process globals.
        let _g = test_global_lock();
        let reset: WorkspaceResetHandler = Arc::new(|| Ok(()));
        let server =
            start_desktop_bridge(Arc::new(DownloadState::default()), reset).expect("start bridge");
        let port = server.bridge.port;
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());

        server.shutdown();

        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn bridge_stop_is_idempotent_across_shutdown_and_drop() {
        let _g = test_global_lock();
        let reset: WorkspaceResetHandler = Arc::new(|| Ok(()));
        let server =
            start_desktop_bridge(Arc::new(DownloadState::default()), reset).expect("start bridge");
        let stop_runs = Arc::clone(&server.stop_body_runs);
        // shutdown() calls stop once; Drop calls stop again and must no-op.
        server.shutdown();
        assert_eq!(
            stop_runs.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "explicit shutdown + Drop must run the stop body exactly once"
        );
    }

    #[test]
    fn idle_http_preconnect_closes_without_a_bad_request_response() {
        let _g = test_global_lock();
        let reset: WorkspaceResetHandler = Arc::new(|| Ok(()));
        let server =
            start_desktop_bridge(Arc::new(DownloadState::default()), reset).expect("start bridge");
        let mut idle =
            TcpStream::connect(("127.0.0.1", server.bridge.port)).expect("open idle preconnect");
        idle.set_read_timeout(Some(Duration::from_secs(3)))
            .expect("idle read timeout");

        let mut response = [0_u8; 256];
        let read = idle
            .read(&mut response)
            .expect("bridge should close idle preconnect");

        assert_eq!(
            read, 0,
            "idle preconnect must close without an HTTP response"
        );
        server.shutdown();
    }

    #[test]
    fn profile_fs_retry_returns_the_cached_result_without_reexecution() {
        let _g = test_global_lock();
        let root = std::env::temp_dir().join(format!(
            "lunery-profile-fs-cache-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        for directory in [
            "config",
            "data/pglite",
            "data/media",
            "models",
            "runtime",
            "logs",
        ] {
            fs::create_dir_all(root.join(directory)).expect("profile directory");
        }
        std::env::set_var("LUNERY_HOME", &root);
        fs::write(root.join("models/source.tmp"), b"first").expect("source");
        let mut cache = ProfileFsResultCache::default();
        let request = || ProfileFsEnvelope {
            request_id: "request-id-00000001".to_string(),
            request: ProfileFsRequest::Rename {
                root: ProfileFsRoot::Models,
                source_relative_path: "source.tmp".to_string(),
                destination_relative_path: "destination.json".to_string(),
                replace: false,
            },
        };

        cache.execute(request()).expect("first rename");
        fs::write(root.join("models/source.tmp"), b"second").expect("replacement source");
        cache.execute(request()).expect("cached retry");

        assert_eq!(
            fs::read(root.join("models/source.tmp")).expect("retry source preserved"),
            b"second"
        );
        assert_eq!(
            fs::read(root.join("models/destination.json")).expect("first destination"),
            b"first"
        );
        std::env::remove_var("LUNERY_HOME");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn long_and_control_lanes_are_separated() {
        assert_eq!(
            classify_bridge_lane("GET", "/download-events"),
            BridgeLane::Long
        );
        assert_eq!(
            classify_bridge_lane("POST", "/sd-generate"),
            BridgeLane::Long
        );
        assert_eq!(classify_bridge_lane("GET", "/status"), BridgeLane::Control);
        assert_eq!(
            classify_bridge_lane("POST", "/sd-cancel"),
            BridgeLane::Control
        );
        assert_eq!(
            classify_bridge_lane("POST", "/provider-secret-read"),
            BridgeLane::Control
        );
        assert_eq!(
            classify_bridge_lane("POST", "/reset-workspace"),
            BridgeLane::Control
        );
    }

    #[test]
    fn eight_long_operations_leave_control_capacity() {
        let admission = BridgeAdmission::new();
        for _ in 0..BRIDGE_MAX_LONG {
            assert!(admission.try_admit_lane(BridgeLane::Long));
        }
        assert!(!admission.try_admit_lane(BridgeLane::Long));
        for _ in 0..BRIDGE_MAX_CONTROL {
            assert!(admission.try_admit_lane(BridgeLane::Control));
        }
        assert!(!admission.try_admit_lane(BridgeLane::Control));
        admission.revoke();
        assert!(admission.is_revoked());
        assert!(!admission.try_admit_connection());
    }

    /// User-facing contract: eight authenticated long SSE download-event
    /// connections must not consume control-lane capacity. A bounded control
    /// request (/status) completes without 429 while those SSE streams are held.
    #[test]
    fn eight_authenticated_sse_connections_leave_control_lane_responsive() {
        let _g = test_global_lock();
        let download_state = Arc::new(DownloadState::default());
        // Seed eight nonterminal jobs so SSE subscriptions stay open.
        for i in 0..BRIDGE_MAX_LONG {
            let job_id = format!("sse-job-{i}");
            let (tx, _) = tokio::sync::broadcast::channel(8);
            let cancel = Arc::new(DownloadCancel::new());
            download_state.0.lock().expect("jobs").insert(
                job_id,
                DownloadJob {
                    status: "downloading".to_string(),
                    received: 1,
                    total: 100,
                    error: None,
                    destination: std::env::temp_dir().join(format!("sse-{i}.gguf")),
                    owns_destination: true,
                    finished_at: None,
                    request_identity: None,
                    cancel,
                    tx,
                },
            );
        }

        let reset: WorkspaceResetHandler = Arc::new(|| Ok(()));
        let server = start_desktop_bridge(Arc::clone(&download_state), reset).expect("bridge");
        let port = server.bridge.port;
        let token = server.bridge.token.clone();

        let ready = Arc::new(Barrier::new(BRIDGE_MAX_LONG + 1));
        let release = Arc::new(Barrier::new(BRIDGE_MAX_LONG + 1));
        let mut sse_threads = Vec::new();
        for i in 0..BRIDGE_MAX_LONG {
            let token = token.clone();
            let ready = Arc::clone(&ready);
            let release = Arc::clone(&release);
            sse_threads.push(thread::spawn(move || {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect sse");
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .expect("read timeout");
                let request = format!(
                    "GET /download-events?jobId=sse-job-{i} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Lunery-Desktop-Token: {token}\r\nConnection: close\r\n\r\n"
                );
                stream
                    .write_all(request.as_bytes())
                    .expect("write sse request");
                // Wait until headers + first SSE frame arrive so the long lane
                // slot is definitively held before the control probe.
                let mut buf = [0u8; 4096];
                let mut received = Vec::new();
                let deadline = Instant::now() + Duration::from_secs(3);
                while Instant::now() < deadline {
                    match stream.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            received.extend_from_slice(&buf[..n]);
                            let text = String::from_utf8_lossy(&received);
                            if received.windows(4).any(|w| w == b"\r\n\r\n")
                                && (text.contains("data:") || text.contains("downloading"))
                            {
                                ready.wait();
                                // Hold the connection until both control probes
                                // have completed; no sleep-based race.
                                release.wait();
                                return;
                            }
                        }
                        Err(err)
                            if err.kind() == std::io::ErrorKind::WouldBlock
                                || err.kind() == std::io::ErrorKind::TimedOut =>
                        {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(err) => panic!("sse read failed: {err}"),
                    }
                }
                panic!(
                    "SSE connection {i} did not become ready; got: {}",
                    String::from_utf8_lossy(&received)
                );
            }));
        }

        // Wait until all eight long SSE workers have entered the long lane.
        ready.wait();

        let control_deadline = Duration::from_millis(1500);
        let started = Instant::now();
        let mut control = TcpStream::connect(("127.0.0.1", port)).expect("control connect");
        control
            .set_read_timeout(Some(control_deadline))
            .expect("control read timeout");
        control
            .set_write_timeout(Some(control_deadline))
            .expect("control write timeout");
        let control_req = format!(
            "GET /status HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Lunery-Desktop-Token: {token}\r\nConnection: close\r\n\r\n"
        );
        control
            .write_all(control_req.as_bytes())
            .expect("control write");
        let mut response = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match control.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => response.extend_from_slice(&buf[..n]),
                Err(err)
                    if err.kind() == std::io::ErrorKind::WouldBlock
                        || err.kind() == std::io::ErrorKind::TimedOut =>
                {
                    break;
                }
                Err(err) => panic!("control read failed: {err}"),
            }
            if started.elapsed() > control_deadline {
                break;
            }
        }
        let elapsed = started.elapsed();
        let body = String::from_utf8_lossy(&response);
        assert!(
            elapsed <= control_deadline,
            "control /status must complete within {control_deadline:?}, took {elapsed:?}"
        );
        assert!(
            body.contains("HTTP/1.1 200"),
            "control must succeed without 429; got: {body}"
        );
        assert!(
            !body.contains("429"),
            "eight long SSE connections must not starve control lane; got: {body}"
        );

        // Also probe /sd-cancel as a second control route under the same load.
        let started = Instant::now();
        let mut cancel_stream = TcpStream::connect(("127.0.0.1", port)).expect("sd-cancel connect");
        cancel_stream
            .set_read_timeout(Some(control_deadline))
            .expect("cancel read timeout");
        let cancel_body = r#"{"runId":"control-probe-run"}"#;
        let cancel_req = format!(
            "POST /sd-cancel HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Lunery-Desktop-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{cancel_body}",
            cancel_body.len()
        );
        cancel_stream
            .write_all(cancel_req.as_bytes())
            .expect("cancel write");
        let mut cancel_response = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match cancel_stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => cancel_response.extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
            if started.elapsed() > control_deadline {
                break;
            }
        }
        let cancel_text = String::from_utf8_lossy(&cancel_response);
        assert!(
            started.elapsed() <= control_deadline,
            "control /sd-cancel must complete within bound"
        );
        assert!(
            cancel_text.contains("HTTP/1.1 200"),
            "sd-cancel control must succeed under eight SSE holders: {cancel_text}"
        );

        release.wait();
        for handle in sse_threads {
            handle.join().expect("SSE client");
        }
        server.shutdown();
    }

    #[test]
    fn shutdown_bounds_a_nonreading_sse_client() {
        let _g = test_global_lock();
        let download_state = Arc::new(DownloadState::default());
        let (tx, _) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(DownloadCancel::new());
        download_state.0.lock().expect("jobs").insert(
            "blocked-sse".to_string(),
            DownloadJob {
                status: "downloading".to_string(),
                received: 1,
                total: 100,
                error: None,
                destination: std::env::temp_dir().join("blocked-sse.gguf"),
                owns_destination: true,
                finished_at: None,
                request_identity: None,
                cancel,
                tx: tx.clone(),
            },
        );
        let reset: WorkspaceResetHandler = Arc::new(|| Ok(()));
        let server = start_desktop_bridge(Arc::clone(&download_state), reset).expect("bridge");
        let port = server.bridge.port;
        let token = server.bridge.token.clone();
        let mut client = TcpStream::connect(("127.0.0.1", port)).expect("SSE connect");
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("read timeout");
        let request = format!(
            "GET /download-events?jobId=blocked-sse HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Lunery-Desktop-Token: {token}\r\nConnection: close\r\n\r\n"
        );
        client.write_all(request.as_bytes()).expect("SSE request");
        let mut initial = [0u8; 4096];
        let read = client.read(&mut initial).expect("initial SSE frame");
        assert!(String::from_utf8_lossy(&initial[..read]).contains("HTTP/1.1 200"));

        // Stop reading, then force a payload larger than the loopback socket
        // buffer so the worker can be inside write_all when shutdown revokes it.
        assert!(
            tx.send(JobSnapshot {
                status: "downloading".to_string(),
                received: 2,
                total: 100,
                error: Some("x".repeat(16 * 1024 * 1024)),
            })
            .is_ok(),
            "large SSE snapshot must have a receiver"
        );
        thread::sleep(Duration::from_millis(100));

        let started = Instant::now();
        server.shutdown();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "SSE write timeout must bound true worker join"
        );
        drop(client);
    }

    #[test]
    fn shutdown_cancels_and_waits_for_background_download_tasks() {
        let _g = test_global_lock();
        let download_state = Arc::new(DownloadState::default());
        let (tx, _) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(DownloadCancel::new());
        download_state.begin_background_task();
        download_state.0.lock().expect("jobs").insert(
            "background-download".to_string(),
            DownloadJob {
                status: "downloading".to_string(),
                received: 1,
                total: 100,
                error: None,
                destination: std::env::temp_dir().join("background-download.gguf"),
                owns_destination: true,
                finished_at: None,
                request_identity: None,
                cancel: Arc::clone(&cancel),
                tx: tx.clone(),
            },
        );
        let writes = Arc::new(AtomicUsize::new(0));
        let worker_state = Arc::clone(&download_state);
        let worker_writes = Arc::clone(&writes);
        let worker = thread::spawn(move || {
            while !cancel.is_canceled() {
                worker_writes.fetch_add(1, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(2));
            }
            // Make the wait observable: shutdown must not return at cancel
            // request time; it returns only after the task commits terminal.
            thread::sleep(Duration::from_millis(40));
            update_job_status(
                &worker_state,
                "background-download",
                &tx,
                "canceled",
                1,
                100,
                None,
            );
            worker_state.finish_background_task();
        });

        let reset: WorkspaceResetHandler = Arc::new(|| Ok(()));
        let server = start_desktop_bridge(Arc::clone(&download_state), reset).expect("bridge");
        server.shutdown();
        worker.join().expect("background task");
        let writes_at_shutdown = writes.load(Ordering::SeqCst);
        thread::sleep(Duration::from_millis(20));
        assert_eq!(writes.load(Ordering::SeqCst), writes_at_shutdown);
        assert_eq!(
            download_state
                .0
                .lock()
                .expect("jobs")
                .get("background-download")
                .expect("job")
                .status,
            "canceled"
        );
    }

    #[test]
    fn shutdown_cancels_a_real_auxiliary_head_that_never_responds() {
        let _g = test_global_lock();
        let upstream = TcpListener::bind("127.0.0.1:0").expect("bind stalled HEAD server");
        let upstream_addr = upstream.local_addr().expect("upstream address");
        let (accepted_tx, accepted_rx) = std::sync::mpsc::channel();
        let upstream_thread = thread::spawn(move || {
            let (mut socket, _) = upstream.accept().expect("accept HEAD request");
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .expect("upstream timeout");
            let mut request = [0u8; 4096];
            let read = socket.read(&mut request).expect("read HEAD request");
            assert!(String::from_utf8_lossy(&request[..read]).starts_with("HEAD "));
            accepted_tx.send(()).expect("signal accepted HEAD");
            // Never send response headers. Cancellation must drop the request
            // future and close this socket before the server timeout matters.
            let _ = socket.read(&mut request);
        });

        let download_state = Arc::new(DownloadState::default());
        let (tx, _) = tokio::sync::broadcast::channel(8);
        let cancel = Arc::new(DownloadCancel::new());
        download_state.begin_background_task();
        download_state.0.lock().expect("jobs").insert(
            "auxiliary-head".to_string(),
            DownloadJob {
                status: "downloading".to_string(),
                received: 1,
                total: 100,
                error: None,
                destination: std::env::temp_dir().join("auxiliary-head.gguf"),
                owns_destination: true,
                finished_at: None,
                request_identity: None,
                cancel: Arc::clone(&cancel),
                tx: tx.clone(),
            },
        );
        let worker_state = Arc::clone(&download_state);
        let worker = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime");
            let result = runtime.block_on(auxiliary_head_for_shutdown_test(
                &format!("http://{upstream_addr}/metadata"),
                &cancel,
            ));
            assert!(
                result
                    .expect_err("shutdown must cancel HEAD")
                    .contains("canceled"),
                "auxiliary request must report cancellation"
            );
            update_job_status(
                &worker_state,
                "auxiliary-head",
                &tx,
                "canceled",
                1,
                100,
                None,
            );
            worker_state.finish_background_task();
        });
        accepted_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("auxiliary HEAD accepted");

        let reset: WorkspaceResetHandler = Arc::new(|| Ok(()));
        let server = start_desktop_bridge(Arc::clone(&download_state), reset).expect("bridge");
        let started = Instant::now();
        server.shutdown();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "shutdown must wake the real auxiliary HEAD"
        );
        worker.join().expect("auxiliary worker");
        upstream_thread.join().expect("stalled HEAD server");
        assert_eq!(
            download_state
                .0
                .lock()
                .expect("jobs")
                .get("auxiliary-head")
                .expect("job")
                .status,
            "canceled"
        );
    }
}
