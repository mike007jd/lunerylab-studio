use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::download::{hf_download_start_inner, DownloadState, JobSnapshot};
use crate::engine_llama::{bridge_start_llama, bridge_stop_llama, llama_engine_slot};
use crate::engine_mlx::{
    bridge_start_mlx, bridge_stop_mlx, mlx_engine_slot, mlx_job_slot, mlx_progress_slot,
};
use crate::engine_sd::{
    bridge_cancel_sd, bridge_finish_sd, bridge_sd_generate, sd_binary_path, sd_progress_for_run,
    valid_sd_run_id, SdGenerateBody, SdProgressPhase,
};
use crate::external_apps::launch_external_app;
use crate::hardware::{detect_hardware, probe_local_runtime};
use crate::secrets::{
    audit_secret_read, delete_provider_secret, get_provider_secret, save_provider_secret,
    secret_read_rate_limit_ok, ProviderIdPayload, ProviderSecretPayload,
};
use crate::security::{bridge_token, constant_time_eq, host_is_loopback};
use crate::DesktopBridge;

fn read_http_request(
    stream: &mut TcpStream,
) -> Result<(String, String, HashMap<String, String>, String), String> {
    // Per-chunk read timeout: short enough that a slow-loris attacker can't
    // hold the socket open by dribbling one byte every few seconds.
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|err| err.to_string())?;

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
            return Err("Request envelope exceeded 10s".to_string());
        }
        let read = stream.read(&mut chunk).map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);

        if header_end.is_none() {
            if buffer.len() > MAX_HEADER_BYTES {
                return Err("Request headers too large".to_string());
            }
            if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                header_end = Some(position + 4);
                let headers = String::from_utf8_lossy(&buffer[..position]).to_string();
                for line in headers.lines().skip(1) {
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            content_length = value.trim().parse::<usize>().unwrap_or_default();
                            if content_length >= MAX_BODY_BYTES {
                                return Err("Request body too large".to_string());
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

    let end = header_end.ok_or_else(|| "Invalid HTTP request".to_string())?;
    let header_text = String::from_utf8_lossy(&buffer[..end]).to_string();
    let body = String::from_utf8_lossy(&buffer[end..]).to_string();
    let mut lines = header_text.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| "Missing request line".to_string())?;
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
        body.as_bytes().len()
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
fn query_param<'a>(query: &'a str, key: &str) -> Option<String> {
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
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));

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

    // Drain the broadcast channel until terminal or client disconnect.
    // We're on a blocking thread, so spawning an async forwarder on Tauri's
    // runtime + bridging through an unbounded tokio mpsc keeps the broadcast
    // receiver awaitable while letting this thread block cleanly on the local
    // queue. This avoids `handle.block_on()` (which pins a runtime worker per
    // SSE connection and can deadlock if Tauri ever runs a single-thread rt).
    let (tx_local, mut rx_local) = tokio::sync::mpsc::unbounded_channel::<
        Result<JobSnapshot, tokio::sync::broadcast::error::RecvError>,
    >();
    tauri::async_runtime::spawn(async move {
        let mut broadcast_rx = rx;
        loop {
            let result = broadcast_rx.recv().await;
            let stop = matches!(
                result,
                Err(tokio::sync::broadcast::error::RecvError::Closed),
            );
            if tx_local.send(result).is_err() {
                break;
            }
            if stop {
                break;
            }
        }
    });

    loop {
        let result = match rx_local.blocking_recv() {
            Some(r) => r,
            None => return,
        };
        match result {
            Ok(snapshot) => {
                if !emit(stream, &snapshot) {
                    return; // client disconnected
                }
                if is_terminal(&snapshot.status) {
                    let _ = write_chunked_frame(stream, b""); // HTTP chunked terminator
                    return;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
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
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
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

fn handle_bridge_request(mut stream: TcpStream, token: &str, download_state: Arc<DownloadState>) {
    let Ok((method, path, headers, body)) = read_http_request(&mut stream) else {
        bridge_error(&mut stream, "400 Bad Request", "Invalid request");
        return;
    };

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

    // SSE path — handled separately, writes the full HTTP response itself and returns.
    // Must come BEFORE the match to avoid falling through to the standard responder.
    if method == "GET" && path_only.starts_with("/download-events") {
        handle_sse_download_events(&mut stream, query, &download_state);
        return;
    }

    match (method.as_str(), path_only) {
        ("GET", "/status") => match serde_json::to_string(&crate::desktop_runtime_status()) {
            Ok(payload) => write_http_response(&mut stream, "200 OK", &payload),
            Err(err) => bridge_error(&mut stream, "500 Internal Server Error", &err.to_string()),
        },
        ("POST", "/provider-secret") => {
            match serde_json::from_str::<ProviderSecretPayload>(&body)
                .map_err(|err| err.to_string())
                .and_then(save_provider_secret)
                .and_then(|payload| serde_json::to_string(&payload).map_err(|err| err.to_string()))
            {
                Ok(payload) => write_http_response(&mut stream, "200 OK", &payload),
                Err(err) => bridge_error(&mut stream, "400 Bad Request", &err),
            }
        }
        ("DELETE", "/provider-secret") => {
            match serde_json::from_str::<ProviderIdPayload>(&body)
                .map_err(|err| err.to_string())
                .and_then(delete_provider_secret)
                .and_then(|payload| serde_json::to_string(&payload).map_err(|err| err.to_string()))
            {
                Ok(payload) => write_http_response(&mut stream, "200 OK", &payload),
                Err(err) => bridge_error(&mut stream, "400 Bad Request", &err),
            }
        }
        ("POST", "/provider-secret-read") => {
            // SECURITY: the returned key is never logged anywhere in this
            // handler. Audit logs record the attempt + outcome only.
            //
            // Two-layer hardening:
            //   1. Rate limit globally to 5 reads/minute — caps blast radius
            //      if the bridge token is ever exfiltrated.
            //   2. Audit every request (allow + deny) to stderr so the OS
            //      log captures who tried to read what and when.
            if !secret_read_rate_limit_ok() {
                let provider_for_audit = serde_json::from_str::<ProviderIdPayload>(&body)
                    .map(|p| p.provider_id)
                    .unwrap_or_else(|_| "unknown".to_string());
                audit_secret_read(&provider_for_audit, false, "rate_limited");
                bridge_error(
                    &mut stream,
                    "429 Too Many Requests",
                    "Secret-read rate limit exceeded (5/min).",
                );
                return;
            }
            match serde_json::from_str::<ProviderIdPayload>(&body)
                .map_err(|err| err.to_string())
                .and_then(|payload| {
                    let provider_id = payload.provider_id.clone();
                    match get_provider_secret(payload) {
                        Ok(key) => {
                            audit_secret_read(&provider_id, true, "ok");
                            Ok(key)
                        }
                        Err(err) => {
                            audit_secret_read(&provider_id, false, "lookup_failed");
                            Err(err)
                        }
                    }
                })
                .and_then(|key| {
                    serde_json::to_string(&serde_json::json!({ "key": key }))
                        .map_err(|err| err.to_string())
                }) {
                Ok(payload) => write_http_response(&mut stream, "200 OK", &payload),
                Err(err) => bridge_error(&mut stream, "400 Bad Request", &err),
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
                            &serde_json::json!({ "ok": true }).to_string(),
                        ),
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
                Ok(cancel) => {
                    if let Ok(guard) = download_state.0.lock() {
                        if let Some(job) = guard.get(&cancel.job_id) {
                            job.cancel.store(true, Ordering::Relaxed);
                        }
                    }
                    write_http_response(
                        &mut stream,
                        "200 OK",
                        &serde_json::json!({ "ok": true }).to_string(),
                    );
                }
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
        ("POST", "/llama-start") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct StartBody {
                model_path: String,
            }
            match serde_json::from_str::<StartBody>(&body)
                .map_err(|e| e.to_string())
                .and_then(|b| bridge_start_llama(b.model_path))
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
            })
            .to_string();
            write_http_response(&mut stream, "200 OK", &payload);
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
        ("GET", "/sd-status") => {
            let available = sd_binary_path().is_some();
            let payload = serde_json::json!({
                "available": available,
                "engine": "stable-diffusion.cpp",
            })
            .to_string();
            write_http_response(&mut stream, "200 OK", &payload);
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

/// Cap on concurrent bridge worker threads. The bridge is the only HTTP
/// surface that runs OS-keychain reads + child-process spawns, so a runaway
/// caller (whether bug or token-leak exfiltration loop) used to be able to
/// fork unbounded threads — quickly exhausting the per-process thread limit
/// and bringing the runtime down with it. 8 in-flight is plenty for a single
/// user (most calls finish in <100ms); anything beyond returns 429.
const BRIDGE_MAX_IN_FLIGHT: usize = 8;

pub(crate) fn start_desktop_bridge(
    download_state: Arc<DownloadState>,
) -> Result<DesktopBridge, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("Could not start desktop bridge: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Could not inspect desktop bridge port: {err}"))?
        .port();
    let token = bridge_token()?;
    let bridge_token = token.clone();
    let in_flight = Arc::new(AtomicUsize::new(0));

    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let current = in_flight.fetch_add(1, Ordering::AcqRel);
            if current >= BRIDGE_MAX_IN_FLIGHT {
                in_flight.fetch_sub(1, Ordering::AcqRel);
                bridge_error(
                    &mut stream,
                    "429 Too Many Requests",
                    "Desktop bridge is at capacity; retry after current jobs settle.",
                );
                continue;
            }
            let token = bridge_token.clone();
            let ds = Arc::clone(&download_state);
            let in_flight_for_worker = Arc::clone(&in_flight);
            thread::spawn(move || {
                handle_bridge_request(stream, &token, ds);
                in_flight_for_worker.fetch_sub(1, Ordering::AcqRel);
            });
        }
    });

    Ok(DesktopBridge { port, token })
}
