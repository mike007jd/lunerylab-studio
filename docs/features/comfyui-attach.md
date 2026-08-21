# ComfyUI Attach

Lunery Lab Studio does not bundle or embed a ComfyUI runtime. The Comfy
workspace (`/comfy`, sidebar "Comfy") attaches to a ComfyUI the user already
runs — on this machine, on the LAN, or on a remote box over Tailscale/VPN —
and provides five things around it:

1. **Native canvas window.** "Open canvas" creates a dedicated Tauri window
   (label `comfy-canvas`) that loads the **official ComfyUI frontend served by
   the user's own server** — full graph editing, shortcuts, context menus, and
   queue, 1:1 with the server's own UI. Studio never re-implements the editor;
   the window is created and managed by the desktop bridge
   (`src-tauri/src/comfy_canvas.rs`).
2. **Loopback relay.** Plain-http endpoints are reached through a raw TCP relay
   the bridge binds to `127.0.0.1:8189` (first free port in 8189–8199, bound
   for the process lifetime). The canvas window therefore always loads a
   stable loopback origin:
   - macOS Local Network Privacy never applies to WebView traffic (the native
     process owns the outbound connection);
   - workflows the user saves in the ComfyUI frontend persist across endpoint
     switches and app restarts (same origin → same localStorage);
   - switching connections retargets the relay and force-closes live pipes;
     the canvas window navigates (same URL) so it reconnects to the new
     server. Explicit "reload canvas" forces a fresh page load.
   Https endpoints skip the relay — a TLS handshake addressed to `127.0.0.1`
   cannot validate — and the window navigates directly to the remote URL.
3. **Canvas integration (frame agent).** The Tauri initialization script
   (`src-tauri/src/comfy_frame_agent.js`, injected into the canvas window)
   shares the page origin there, drives the official `window.app` — the same
   integration surface SwarmUI relies on — and exposes
   `window.__luneryComfyHost.loadApiJson(json)` as a command sink. The bridge
   route `POST /comfy-canvas-load` reaches it via `webview.eval`, so Studio
   can push an API-format workflow onto the canvas. The embedded-frame
   postMessage mode is retained for future embed integrations.
4. **Canvas follow.** Studio-submitted generations are recorded in a
   memory-only activity feed (`lib/server/comfy-activity.ts`, polled via
   `GET /api/comfy/activity`). While the canvas window is open, the running
   job's API-format workflow is loaded into it via `/api/comfy/canvas/load`,
   so the official editor highlights the executing graph in real time — this
   is the fix for "Studio generates but the canvas shows nothing".
5. **Connection health, config sync, SSH start**: `/system_stats` probing
   (online/offline badge), model-folder sync snapshots, and the SSH launcher
   for idle-stopped remote boxes.

Image generation routing honors the attach: when a connection is active, the
local image supply resolves `local-comfyui` to that endpoint instead of
autodetecting `127.0.0.1:8188`. An attached-but-down server means comfy is
down — there is no silent fallthrough to a different machine's loopback
instance. With no connection saved, the previous zero-config loopback probe
still applies.

## Storage

Connections live in `<profile>/config/comfyui-connections.json` (atomic
tmp-write + rename through the native bridge fs, same pattern as
`provider-connections.json`). No secrets: ComfyUI endpoints carry no keys.

## Security boundaries

- **Endpoint validation** (`lib/server/comfy-endpoint.ts`): URL credentials,
  query strings, fragments, and cloud-metadata hosts are rejected; the host
  must resolve; mixed public/private DNS answers are rejected. Plain `http` is
  allowed only for loopback/private hosts (LAN/Tailscale reality — ComfyUI
  serves plain http and no credentials are attached); public hosts require
  `https`. Validation runs at save, at test, at sync, at supply dispatch, and
  at canvas open.
- **Relay containment** (`comfy_canvas.rs`): the relay binds loopback only and
  forwards bytes to exactly one upstream — the validated active endpoint. It
  is a byte pipe (HTTP, WebSocket upgrades, and binary media all pass
  through); no request rewriting, no auth bypass beyond what loopback already
  grants. Retargeting is the only mutation, and it kicks every live pipe.
- **Canvas window isolation**: `capabilities/desktop-runtime.json` keeps
  `remote.urls` empty, so the canvas window (any origin) cannot invoke Tauri
  IPC. Window open/close/eval happen exclusively inside bridge routes after
  the Next.js trust boundary.
- **No iframe, no frame-src exceptions**: the WebView loads only app pages;
  the dynamic `frame-src` CSP machinery was removed with the iframe design.
- **No ATS exception**: the former `NSAllowsArbitraryLoadsInWebContent`
  Info.plist override is gone — WebView content is loopback-only again.
- **SSH start** (`src-tauri/src/comfy_remote.rs`): argv-only invocation, no
  local shell; the alias must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (a
  leading `-` is impossible, so it can never be parsed as an ssh option); the
  command is single-line and length-capped; stdin is null (no interactive
  password hang); 25 s hard timeout; output capped at 64 KiB.

## macOS Local Network permission (LAN endpoints)

The WebView only ever talks to `127.0.0.1`, so canvas browsing itself never
triggers the Local Network prompt. The outbound connection to a LAN endpoint
now comes from the native process; unsigned/adhoc builds may still need the
one-time Local Network grant ("…find devices on local networks") for it —
choose Allow on the system prompt, or re-approve under System Settings →
Privacy & Security → Local Network. Tailscale endpoints (`100.64.0.0/10`
CGNAT) are not treated as local network and work without the grant, which
makes them the most friction-free remote path.

## API surface

| Route | Purpose |
| --- | --- |
| `GET/POST/DELETE /api/comfy/connections` | list / save (validate) / remove |
| `POST /api/comfy/connections/activate` | set the active connection |
| `POST /api/comfy/connections/test` | `{id}` or `{endpoint}` → `/system_stats` |
| `POST /api/comfy/connections/sync` | pull system stats + model folders |
| `POST /api/comfy/connections/start` | bridge `/comfy-ssh-start` passthrough |
| `GET /api/comfy/activity` | recent Studio-submitted jobs (memory-only feed) |
| `POST /api/comfy/canvas/open` | `{id?, reload?}` → open/focus the canvas window |
| `POST /api/comfy/canvas/close` | close the canvas window |
| `POST /api/comfy/canvas/load` | `{workflow}` → load API-format workflow on the canvas |

Bridge routes (token-authenticated, loopback-only): `/comfy-canvas-open`,
`/comfy-canvas-close`, `/comfy-canvas-status`, `/comfy-canvas-load`,
`/comfy-ssh-start`.

## Frame agent contract

Standalone canvas window: the agent polls for the frontend's `window.app`
(≤60 s), then exposes `window.__luneryComfyHost.loadApiJson(workflowJson)` —
the bridge's `/comfy-canvas-load` eval calls exactly that. Load errors surface
inside the ComfyUI UI itself.

Embedded-frame mode (retained): messages are namespaced with
`__luneryComfy: true`. The agent sends `ready` once `window.app` appears, then
one `event` message per relayed ComfyApi event; the host sends `load-api-json`
commands (`{jobId, workflow}`) and the agent acknowledges with
`ack {jobId, ok, error?}`.
