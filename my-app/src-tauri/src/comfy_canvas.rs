// ComfyUI canvas: loopback TCP relay + native canvas window management.
//
// The Studio attaches to a remote ComfyUI server. Instead of pointing the
// WebView straight at that server (macOS Local Network Privacy silently blocks
// LAN origins, and every endpoint change would move the WebView origin and
// lose the frontend's saved workflows), the desktop bridge owns a plain TCP
// relay bound to 127.0.0.1. The canvas window always loads a stable loopback
// origin; the relay pipes raw bytes — HTTP, WebSocket upgrades, and binary
// media streams all pass through untouched — to the configured server.
//
// Plain-http endpoints go through the relay. Https endpoints skip it (a TLS
// handshake addressed to 127.0.0.1 would fail certificate validation) and the
// canvas window navigates directly to the remote URL.

use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const CANVAS_WINDOW_LABEL: &str = "comfy-canvas";
/// Preferred relay ports. The first free port wins and stays bound for the
/// process lifetime, so the canvas origin is stable across endpoint switches.
const RELAY_PORT_RANGE: std::ops::RangeInclusive<u16> = 8189..=8199;

#[derive(Clone, PartialEq, Eq)]
struct ForwardTarget {
    host: String,
    port: u16,
}

fn parse_http_forward_target(endpoint: &str) -> Result<ForwardTarget, String> {
    let url =
        tauri::Url::parse(endpoint).map_err(|_| "Invalid ComfyUI endpoint URL".to_string())?;
    if url.scheme() != "http" {
        return Err(
            "Only plain-http ComfyUI endpoints are served through the loopback canvas relay"
                .to_string(),
        );
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("ComfyUI endpoints must not carry credentials".to_string());
    }
    let host = url
        .host_str()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "ComfyUI endpoint is missing a host".to_string())?;
    // The url crate already strips IPv6 brackets; trim defensively anyway so a
    // literal bracketed host can never reach TcpStream::connect.
    let host = host.trim_start_matches('[').trim_end_matches(']');
    Ok(ForwardTarget {
        host: host.to_string(),
        port: url.port_or_known_default().unwrap_or(80),
    })
}

type LiveClient = (u64, TcpStream);

static NEXT_RELAY_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

struct ActiveRelay {
    listen_port: u16,
    target: Arc<Mutex<Option<ForwardTarget>>>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    live_clients: Arc<Mutex<Vec<LiveClient>>>,
    conn_threads: Arc<Mutex<Vec<JoinHandle<()>>>>,
    listener_thread: Option<JoinHandle<()>>,
}

/// Loopback byte-pipe to the attached ComfyUI server. The listener stays bound
/// for the process lifetime; retargeting swaps the upstream address and force-
/// closes live pipes so browsers reconnect against the new server.
#[derive(Default)]
pub(crate) struct ComfyCanvasRelay {
    active: Mutex<Option<ActiveRelay>>,
}

impl ComfyCanvasRelay {
    /// Ensure the relay forwards to `endpoint`. Returns `(loopback port,
    /// retargeted)` — `retargeted` is true when the upstream changed and live
    /// pipes were force-closed.
    pub(crate) fn ensure_target(&self, endpoint: &str) -> Result<(u16, bool), String> {
        let ports: Vec<u16> = RELAY_PORT_RANGE.collect();
        self.ensure_target_on_ports(endpoint, &ports)
    }

    fn ensure_target_on_ports(
        &self,
        endpoint: &str,
        ports: &[u16],
    ) -> Result<(u16, bool), String> {
        let target = parse_http_forward_target(endpoint)?;
        let mut guard = self
            .active
            .lock()
            .map_err(|_| "ComfyUI canvas relay state is poisoned".to_string())?;

        if let Some(active) = guard.as_ref() {
            let mut current = active
                .target
                .lock()
                .map_err(|_| "ComfyUI canvas relay target is poisoned".to_string())?;
            let changed = match current.as_ref() {
                Some(existing) => existing.host != target.host || existing.port != target.port,
                None => true,
            };
            if changed {
                *current = Some(target);
                drop(current);
                kick_live_clients(&active.live_clients);
            }
            return Ok((active.listen_port, changed));
        }

        let mut bound = None;
        for port in ports {
            match TcpListener::bind((std::net::IpAddr::from(Ipv4Addr::LOCALHOST), *port)) {
                Ok(listener) => {
                    bound = Some((listener, *port));
                    break;
                }
                Err(_) => continue,
            }
        }
        let (listener, listen_port) = bound
            .ok_or_else(|| "No free loopback port for the ComfyUI canvas relay".to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|err| format!("Could not configure the ComfyUI canvas relay: {err}"))?;

        let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let target_shared = Arc::new(Mutex::new(Some(target)));
        let live_clients: Arc<Mutex<Vec<LiveClient>>> = Arc::new(Mutex::new(Vec::new()));
        let conn_threads: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));

        let listener_shutdown = Arc::clone(&shutdown);
        let listener_target = Arc::clone(&target_shared);
        let listener_live = Arc::clone(&live_clients);
        let listener_threads = Arc::clone(&conn_threads);
        let listener_thread = std::thread::Builder::new()
            .name("comfy-canvas-relay".to_string())
            .spawn(move || {
                while !listener_shutdown.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((client, _)) => {
                            if listener_shutdown.load(Ordering::Acquire) {
                                break;
                            }
                            // BSD/macOS accepted sockets inherit the listener's
                            // non-blocking flag; the relay pipes need blocking
                            // semantics.
                            let _ = client.set_nonblocking(false);
                            let target = Arc::clone(&listener_target);
                            let live = Arc::clone(&listener_live);
                            let spawned = std::thread::Builder::new()
                                .name("comfy-canvas-relay-conn".to_string())
                                .spawn(move || {
                                    handle_relay_connection(client, target, live);
                                });
                            if let Ok(handle) = spawned {
                                if let Ok(mut guard) = listener_threads.lock() {
                                    guard.retain(|handle| !handle.is_finished());
                                    guard.push(handle);
                                }
                            }
                        }
                        Err(_) => {
                            std::thread::sleep(Duration::from_millis(25));
                        }
                    }
                }
            })
            .map_err(|err| format!("Could not start the ComfyUI canvas relay: {err}"))?;

        *guard = Some(ActiveRelay {
            listen_port,
            target: target_shared,
            shutdown,
            live_clients,
            conn_threads,
            listener_thread: Some(listener_thread),
        });
        Ok((listen_port, false))
    }

    /// `(listen port, "host:port" upstream)` when the relay is active.
    pub(crate) fn status(&self) -> Option<(u16, String)> {
        let guard = self.active.lock().ok()?;
        let active = guard.as_ref()?;
        let target = active.target.lock().ok()?;
        let target = target.as_ref()?;
        Some((
            active.listen_port,
            format!("{}:{}", target.host, target.port),
        ))
    }

    pub(crate) fn stop(&self) {
        let active = {
            let mut guard = match self.active.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            guard.take()
        };
        let Some(active) = active else {
            return;
        };
        active.shutdown.store(true, Ordering::Release);
        // Wake the nonblocking accept loop immediately.
        let _ = TcpStream::connect(("127.0.0.1", active.listen_port));
        kick_live_clients(&active.live_clients);
        if let Some(thread) = active.listener_thread {
            let _ = thread.join();
        }
        let threads_lock = active.conn_threads.lock();
        if let Ok(mut threads) = threads_lock {
            for handle in threads.drain(..) {
                let _ = handle.join();
            }
        }
    }
}

fn kick_live_clients(live_clients: &Arc<Mutex<Vec<LiveClient>>>) {
    if let Ok(mut guard) = live_clients.lock() {
        for (_, stream) in guard.iter() {
            // Shutting the client side down unblocks both copy directions of
            // the relay worker; the upstream half dies with them.
            let _ = stream.shutdown(Shutdown::Both);
        }
        guard.clear();
    }
}

fn deregister_live_client(live_clients: &Arc<Mutex<Vec<LiveClient>>>, connection_id: u64) {
    if let Ok(mut guard) = live_clients.lock() {
        guard.retain(|(id, _)| *id != connection_id);
    }
}

/// Minimal plain-text HTTP error for browsers whose request arrived before the
/// relay had a usable upstream (or when the upstream refuses the connection).
fn write_relay_http_error(stream: &mut TcpStream, status: &str, body: &str) {
    use std::io::Write;
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn handle_relay_connection(
    mut client: TcpStream,
    target: Arc<Mutex<Option<ForwardTarget>>>,
    live_clients: Arc<Mutex<Vec<LiveClient>>>,
) {
    let connection_id = NEXT_RELAY_CONNECTION_ID.fetch_add(1, Ordering::Relaxed);
    if let Ok(clone) = client.try_clone() {
        if let Ok(mut guard) = live_clients.lock() {
            guard.push((connection_id, clone));
        }
    }

    let outcome = (|| -> std::io::Result<()> {
        let snapshot = target
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .ok_or_else(|| std::io::Error::other("relay has no upstream target"))?;
        let mut upstream = TcpStream::connect((snapshot.host.as_str(), snapshot.port))?;
        let _ = client.set_nodelay(true);
        let _ = upstream.set_nodelay(true);

        let mut client_down = client.try_clone()?;
        let mut upstream_down = upstream.try_clone()?;
        let upstream_to_client = std::thread::Builder::new()
            .name("comfy-canvas-relay-pipe".to_string())
            .spawn(move || {
                let _ = std::io::copy(&mut upstream_down, &mut client_down);
                let _ = client_down.shutdown(Shutdown::Both);
            })
            .ok();

        // Client -> upstream runs inline; when either direction finishes, both
        // halves are torn down below.
        let _ = std::io::copy(&mut client, &mut upstream);
        let _ = upstream.shutdown(Shutdown::Both);
        let _ = client.shutdown(Shutdown::Both);
        if let Some(handle) = upstream_to_client {
            let _ = handle.join();
        }
        Ok(())
    })();

    if outcome.is_err() {
        write_relay_http_error(
            &mut client,
            "502 Bad Gateway",
            "Lunery could not reach the attached ComfyUI server.",
        );
    }
    deregister_live_client(&live_clients, connection_id);
}

static COMFY_CANVAS_RELAY: std::sync::OnceLock<ComfyCanvasRelay> = std::sync::OnceLock::new();

pub(crate) fn comfy_canvas_relay() -> &'static ComfyCanvasRelay {
    COMFY_CANVAS_RELAY.get_or_init(ComfyCanvasRelay::default)
}

// ---------------------------------------------------------------------------
// Native canvas window management
// ---------------------------------------------------------------------------

/// Run `work` on the main thread (required for window operations on macOS) and
/// wait for its result. Bridge worker threads call this for every canvas
/// window operation.
fn run_on_main_thread_with<T: Send + 'static>(
    app: &tauri::AppHandle,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(work());
    })
    .map_err(|err| format!("Could not schedule canvas window work: {err}"))?;
    receiver
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "Canvas window work timed out".to_string())
}

fn validate_canvas_endpoint(endpoint: &str) -> Result<tauri::Url, String> {
    let url =
        tauri::Url::parse(endpoint).map_err(|_| "Invalid ComfyUI endpoint URL".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("ComfyUI endpoints must use http or https".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("ComfyUI endpoints must not carry credentials".to_string());
    }
    if url
        .host_str()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .is_none()
    {
        return Err("ComfyUI endpoint is missing a host".to_string());
    }
    Ok(url)
}

/// Frame-agent initialization script for the canvas window. When the Studio
/// server origin is known, it is injected so the agent can beacon graph state
/// back to `/api/comfy/canvas/report`.
fn canvas_agent_script() -> String {
    match crate::studio_origin_global() {
        Some(origin) => format!(
            "window.__LUNERY_STUDIO_ORIGIN = '{}';\n{}",
            origin,
            include_str!("comfy_frame_agent.js")
        ),
        None => include_str!("comfy_frame_agent.js").to_string(),
    }
}

fn open_or_focus_canvas_window(
    app: &tauri::AppHandle,
    url: tauri::Url,
    force_reload: bool,
    agent_script: &str,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(CANVAS_WINDOW_LABEL) {
        // Re-opening the same server must not reload the frontend by default:
        // unsaved graph edits live only in that document.
        let needs_navigation =
            force_reload || existing.url().map(|current| current != url).unwrap_or(true);
        if needs_navigation {
            existing
                .navigate(url.clone())
                .map_err(|err| format!("Could not point the canvas at the server: {err}"))?;
        }
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, CANVAS_WINDOW_LABEL, WebviewUrl::External(url))
        .title("ComfyUI Canvas")
        .inner_size(1440.0, 980.0)
        .min_inner_size(1180.0, 760.0)
        .initialization_script(agent_script)
        .build()
        .map_err(|err| format!("Could not open the ComfyUI canvas window: {err}"))?;
    Ok(())
}

/// Open (or focus) the native ComfyUI canvas window for `endpoint`.
/// `reload` forces a fresh page load of an already-open canvas (explicit user
/// action or a server restart). Returns the JSON bridge response payload.
pub(crate) fn comfy_canvas_open(endpoint: &str, reload: bool) -> Result<String, String> {
    let url = validate_canvas_endpoint(endpoint)?;
    // Https remotes are loaded directly: TLS is addressed to the real hostname,
    // so a loopback relay cannot sit in front of them.
    let (canvas_url_string, retargeted) = if url.scheme() == "https" {
        (url.to_string(), false)
    } else {
        // A relay retarget means the upstream server changed — the open page
        // would keep talking to the old one, so the window must navigate even
        // though its loopback URL is unchanged.
        let (relay_port, retargeted) = comfy_canvas_relay().ensure_target(endpoint)?;
        (format!("http://127.0.0.1:{relay_port}"), retargeted)
    };

    let canvas_url = tauri::Url::parse(&canvas_url_string)
        .map_err(|err| format!("Invalid canvas URL: {err}"))?;
    let agent_script = canvas_agent_script();
    let app = crate::bridge_app_handle().ok_or_else(|| "Desktop shell is not ready".to_string())?;
    let app_for_main = app.clone();
    run_on_main_thread_with(app, move || {
        open_or_focus_canvas_window(&app_for_main, canvas_url, reload || retargeted, &agent_script)
    })
    .and_then(|opened| opened)?;

    Ok(serde_json::json!({ "ok": true }).to_string())
}

pub(crate) fn comfy_canvas_close() -> Result<(), String> {
    let app = crate::bridge_app_handle().ok_or_else(|| "Desktop shell is not ready".to_string())?;
    let app_for_main = app.clone();
    run_on_main_thread_with(app, move || {
        if let Some(window) = app_for_main.get_webview_window(CANVAS_WINDOW_LABEL) {
            window.close().map_err(|err| err.to_string())?;
        }
        Ok::<(), String>(())
    })
    .and_then(|closed| closed)?;
    Ok(())
}

pub(crate) fn comfy_canvas_status_json() -> Result<String, String> {
    let relay = comfy_canvas_relay()
        .status()
        .map(|(port, target)| serde_json::json!({ "port": port, "target": target }));
    let open = match crate::bridge_app_handle() {
        Some(app) => {
            let app_for_main = app.clone();
            run_on_main_thread_with(app, move || {
                app_for_main
                    .get_webview_window(CANVAS_WINDOW_LABEL)
                    .is_some()
            })
            .unwrap_or(false)
        }
        None => false,
    };
    serde_json::to_string(&serde_json::json!({ "open": open, "relay": relay }))
        .map_err(|err| format!("Could not encode canvas status: {err}"))
}

/// Load an API-format workflow into the canvas window's official frontend via
/// the injected frame agent (`window.__luneryComfyHost`). Fire-and-forget on
/// the page side: load errors surface inside the ComfyUI UI itself.
pub(crate) fn comfy_canvas_load(workflow: &serde_json::Value) -> Result<(), String> {
    let app = crate::bridge_app_handle().ok_or_else(|| "Desktop shell is not ready".to_string())?;
    let payload = serde_json::to_string(workflow)
        .map_err(|err| format!("Could not serialize the workflow: {err}"))?;
    let script = format!(
        "(function(){{var h=window.__luneryComfyHost;if(!h||typeof h.loadApiJson!=='function'){{return 'agent-missing';}}try{{h.loadApiJson({payload});return 'ok';}}catch(err){{return 'load-failed';}}}})()"
    );
    let app_for_main = app.clone();
    run_on_main_thread_with(app, move || {
        let window = app_for_main
            .get_webview_window(CANVAS_WINDOW_LABEL)
            .ok_or_else(|| "The ComfyUI canvas window is not open".to_string())?;
        window
            .eval(&script)
            .map_err(|err| format!("Could not drive the canvas frontend: {err}"))
    })
    .and_then(|loaded| loaded)?;
    Ok(())
}

/// Ask the canvas window's frame agent to serialize the live graph and beacon
/// it to the Studio server (`/api/comfy/canvas/report`). The beacon itself is
/// asynchronous — callers poll the report cache for the fresh snapshot.
pub(crate) fn comfy_canvas_report() -> Result<(), String> {
    let app = crate::bridge_app_handle().ok_or_else(|| "Desktop shell is not ready".to_string())?;
    const SCRIPT: &str = "(function(){var h=window.__luneryComfyHost;if(!h||typeof h.reportState!=='function'){return 'agent-missing';}h.reportState();return 'ok';})()";
    let app_for_main = app.clone();
    run_on_main_thread_with(app, move || {
        let window = app_for_main
            .get_webview_window(CANVAS_WINDOW_LABEL)
            .ok_or_else(|| "The ComfyUI canvas window is not open".to_string())?;
        window
            .eval(SCRIPT)
            .map_err(|err| format!("Could not drive the canvas frontend: {err}"))
    })
    .and_then(|triggered| triggered)?;
    Ok(())
}

pub(crate) fn stop_comfy_canvas_relay() {
    comfy_canvas_relay().stop();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn parse(value: &str) -> Result<ForwardTarget, String> {
        parse_http_forward_target(value)
    }

    #[test]
    fn parses_plain_http_targets_with_explicit_and_default_ports() {
        let target = parse("http://192.168.1.143:8188").expect("valid");
        assert_eq!(target.host, "192.168.1.143");
        assert_eq!(target.port, 8188);

        let defaulted = parse("http://comfy.internal").expect("valid");
        assert_eq!(defaulted.port, 80);
    }

    #[test]
    fn rejects_non_http_and_credentialled_targets() {
        assert!(parse("https://comfy.example.com").is_err());
        assert!(parse("http://user:pass@192.168.1.5:8188").is_err());
        assert!(parse("not a url").is_err());
    }

    /// Accept connections and echo every byte back until the peer closes.
    fn spawn_echo_server() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind echo server");
        let port = listener.local_addr().expect("addr").port();
        thread::spawn(move || {
            for incoming in listener.incoming() {
                let Ok(mut stream) = incoming else { break };
                thread::spawn(move || {
                    let mut buffer = [0_u8; 4096];
                    loop {
                        match stream.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(read) => {
                                if stream.write_all(&buffer[..read]).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
        port
    }

    /// Hold an accepted socket open so forced-disconnect behavior is observable.
    /// Returns the port plus a counter of accepted connections, so tests can
    /// wait until the relay worker actually dialed upstream before retargeting.
    fn spawn_holding_server() -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind holding server");
        let port = listener.local_addr().expect("addr").port();
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let accepted_counter = Arc::clone(&accepted);
        thread::spawn(move || {
            for incoming in listener.incoming() {
                let Ok(mut stream) = incoming else { break };
                accepted_counter.fetch_add(1, Ordering::Relaxed);
                thread::spawn(move || {
                    // Read quietly until the peer goes away.
                    let mut buffer = [0_u8; 1024];
                    while matches!(stream.read(&mut buffer), Ok(read) if read > 0) {}
                });
            }
        });
        (port, accepted)
    }

    #[test]
    fn relays_bytes_bidirectionally_to_the_upstream() {
        let upstream_port = spawn_echo_server();
        let relay = ComfyCanvasRelay::default();
        let listen_port = relay
            .ensure_target_on_ports(&format!("http://127.0.0.1:{upstream_port}"), &[23891])
            .expect("relay starts")
            .0;
        assert_eq!(listen_port, 23891);

        let mut client = TcpStream::connect(("127.0.0.1", listen_port)).expect("connect relay");
        let request = b"GET /system_stats HTTP/1.1\r\n\r\n";
        client.write_all(request).expect("write");
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        let mut echoed = vec![0_u8; request.len()];
        client.read_exact(&mut echoed).expect("echoed response");
        assert_eq!(echoed.as_slice(), request.as_slice());

        relay.stop();
    }

    #[test]
    fn retargeting_force_closes_live_pipes() {
        let (first_port, first_accepted) = spawn_holding_server();
        let (second_port, _second_accepted) = spawn_holding_server();
        let relay = ComfyCanvasRelay::default();
        let listen_port = relay
            .ensure_target_on_ports(&format!("http://127.0.0.1:{first_port}"), &[23892])
            .expect("relay starts")
            .0;

        let mut client = TcpStream::connect(("127.0.0.1", listen_port)).expect("connect");
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");

        // Wait until the relay worker has registered this pipe and dialed the
        // first upstream — otherwise the retarget below races the registration
        // and the forced disconnect lands on an empty registry.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while first_accepted.load(Ordering::Relaxed) == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "relay worker never connected to the first upstream"
            );
            thread::sleep(Duration::from_millis(10));
        }

        // Same target: no disconnect.
        let same = relay
            .ensure_target_on_ports(&format!("http://127.0.0.1:{first_port}"), &[23892])
            .expect("same target");
        assert_eq!(same, (listen_port, false));

        // New target: the live pipe must be torn down promptly (EOF or reset —
        // anything but a silent open socket timing out).
        let retargeted = relay
            .ensure_target_on_ports(&format!("http://127.0.0.1:{second_port}"), &[23892])
            .expect("retarget");
        assert_eq!(retargeted, (listen_port, true));
        let started = std::time::Instant::now();
        let mut drained = Vec::new();
        let outcome = client.read_to_end(&mut drained);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "forced disconnect should be prompt, took {started:?}: {outcome:?}"
        );
        match outcome {
            Ok(_) => {}
            Err(err) => assert_ne!(
                err.kind(),
                std::io::ErrorKind::TimedOut,
                "live pipe was not force-closed after retarget"
            ),
        }

        relay.stop();
    }

    #[test]
    fn falls_back_to_the_next_free_preferred_port() {
        let blocker = TcpListener::bind(("127.0.0.1", 21890)).expect("block first choice");
        let upstream_port = spawn_echo_server();
        let relay = ComfyCanvasRelay::default();
        let listen_port = relay
            .ensure_target_on_ports(
                &format!("http://127.0.0.1:{upstream_port}"),
                &[21890, 21891],
            )
            .expect("relay starts")
            .0;
        assert_eq!(listen_port, 21891);
        relay.stop();
        drop(blocker);
    }

    #[test]
    fn status_reports_none_before_start_and_target_after() {
        let upstream_port = spawn_echo_server();
        let relay = ComfyCanvasRelay::default();
        assert!(relay.status().is_none());
        relay
            .ensure_target_on_ports(&format!("http://127.0.0.1:{upstream_port}"), &[22890])
            .expect("relay starts");
        let (port, target) = relay.status().expect("status after start");
        assert_eq!(port, 22890);
        assert_eq!(target, format!("127.0.0.1:{upstream_port}"));
        relay.stop();
        assert!(relay.status().is_none());
    }
}
