# ComfyUI Attach

Lunery Lab Studio does not bundle or embed a ComfyUI runtime. The Comfy
workspace (`/comfy`, sidebar "Comfy") attaches to a ComfyUI the user already
runs — on this machine, on the LAN, or on a remote box over Tailscale/VPN —
and provides four things around it:

1. **Embedded canvas.** The active connection's web frontend is embedded in an
   iframe served by that ComfyUI instance. The full graph editor is the user's
   own server's UI; Studio only frames it.
2. **Connection health.** `GET /system_stats` is probed on load, on switch, and
   every 30 s while the workspace is visible (online/offline badge, version,
   device).
3. **Config sync.** "Sync" pulls `/system_stats` plus every model folder
   (`/models/{folder}`) into a persisted snapshot per connection, shown in the
   details dialog (version, device, VRAM, Python/PyTorch, model inventory).
4. **SSH start (launcher).** A connection may carry `{ hostAlias, command }`.
   "Start via SSH" asks the native bridge to run `ssh <hostAlias> <command>`
   so the remote machine brings ComfyUI up (e.g. idle-stopped homelab boxes).

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
  `https`. Validation runs at save, at test, at sync, and at supply dispatch.
- **Outbound traffic** uses `createPinnedProviderFetch` (DNS-pinned, no
  redirects, origin/path containment).
- **CSP**: `/comfy` HTML responses get `frame-src 'self' <saved origins>` —
  only configured ComfyUI origins can be framed (`proxy.ts` +
  `lib/server/comfy-frame-origins.ts`).
- **SSH start** (`src-tauri/src/comfy_remote.rs`): argv-only invocation, no
  local shell; the alias must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (a
  leading `-` is impossible, so it can never be parsed as an ssh option); the
  command is single-line and length-capped; stdin is null (no interactive
  password hang); 25 s hard timeout; output capped at 64 KiB.
- **macOS ATS**: `src-tauri/Info.plist` sets
  `NSAppTransportSecurity → NSAllowsArbitraryLoadsInWebContent` so the WebView
  may load plain-http ComfyUI frontends. This lifts ATS for web content only;
  native/URLSession traffic keeps full ATS.

## macOS Local Network permission (LAN endpoints)

Unsigned/adhoc builds must be granted Local Network access before the app can
reach `192.168.x`/`10.x` endpoints: macOS shows a one-time system prompt
("…find devices on local networks") on the first LAN request — choose Allow.
If the prompt was dismissed, re-approve under System Settings → Privacy &
Security → Local Network. Tailscale endpoints (`100.64.0.0/10` CGNAT) are not
treated as local network and work without the grant, which makes them the
most friction-free remote path.

## API surface

| Route | Purpose |
| --- | --- |
| `GET/POST/DELETE /api/comfy/connections` | list / save (validate) / remove |
| `POST /api/comfy/connections/activate` | set the active connection |
| `POST /api/comfy/connections/test` | `{id}` or `{endpoint}` → `/system_stats` |
| `POST /api/comfy/connections/sync` | pull system stats + model folders |
| `POST /api/comfy/connections/start` | bridge `/comfy-ssh-start` passthrough |
