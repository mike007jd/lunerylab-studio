import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import { luneryRuntimeDir } from "@/lib/server/lunery-profile";

export interface DesktopBridge {
  url: string;
  token: string;
}

const DEV_BRIDGE_FILE_NAME = "desktop-dev-bridge.json";

function readDevDesktopBridge(): DesktopBridge | null {
  if (process.env.NODE_ENV === "production") return null;
  try {
    const payload = JSON.parse(
      readFileSync(path.join(luneryRuntimeDir(), DEV_BRIDGE_FILE_NAME), "utf8"),
    ) as { url?: unknown; token?: unknown };
    const url = typeof payload.url === "string" ? payload.url : "";
    const token = typeof payload.token === "string" ? payload.token : "";
    if (!url || !token) return null;
    new URL(url);
    return { url, token };
  } catch {
    return null;
  }
}

export interface BridgeDownloadStartPayload {
  url: string;
  dest: string;
  sha256: string | null;
  jobId: string;
}

/**
 * Shared guard for desktop-runtime API routes.
 *
 * Checks (in order):
 *  1. LUNERY_DESKTOP runtime flag → 404 if absent.
 *  2. LUNERY_DESKTOP_BRIDGE_URL / LUNERY_DESKTOP_BRIDGE_TOKEN env vars → 404 if
 *     either is missing.
 *  3. URL validity of LUNERY_DESKTOP_BRIDGE_URL → 500 if malformed.
 *
 * Returns `{ url, token }` on success, or a `NextResponse` that the caller
 * should return immediately.
 *
 * Error shapes are identical to what every desktop-runtime route previously
 * returned inline:
 *   404  { error: "Desktop runtime bridge is not available" }
 *   500  { error: "bridge unavailable" }
 */
export function requireDesktopBridge():
  | DesktopBridge
  | NextResponse {
  if (!isDesktopRuntime()) {
    return NextResponse.json(
      { error: "Desktop runtime bridge is not available" },
      { status: 404 },
    );
  }

  const url = process.env.LUNERY_DESKTOP_BRIDGE_URL;
  const token = process.env.LUNERY_DESKTOP_BRIDGE_TOKEN;
  const bridge = url && token ? { url, token } : readDevDesktopBridge();

  if (!bridge) {
    return NextResponse.json(
      { error: "Desktop runtime bridge is not available" },
      { status: 404 },
    );
  }

  try {
    new URL(bridge.url);
  } catch {
    return NextResponse.json({ error: "bridge unavailable" }, { status: 500 });
  }

  return bridge;
}

/**
 * Forward a control/status request to the desktop bridge and proxy its
 * response straight back to the caller.
 *
 * The raw `fetch` to the local Rust bridge can reject (process down, socket
 * refused, timeout) — left unguarded that rejection crashes the route handler
 * and the client gets an opaque 500 / connection-reset instead of a typed
 * payload. This wrapper turns any transport failure into a controlled
 * "bridge is not available" response (the same shape `requireDesktopBridge`
 * emits when the bridge is absent), so every desktop-runtime route degrades
 * uniformly. Pass `onUnreachable` to customise that payload (e.g. status
 * polling wants `{ available: false }`).
 *
 * Only use this for short-lived control calls — it applies a hard timeout so
 * a hung bridge never wedges a request indefinitely. Streaming endpoints
 * (SSE passthrough) and the long-running download starter handle their own
 * fetch and must not route through here.
 */
export async function proxyToBridge(
  bridge: DesktopBridge,
  path: string,
  init?: {
    method?: string;
    body?: BodyInit | null;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
  onUnreachable?: () => NextResponse,
): Promise<NextResponse> {
  let response: Response;
  try {
    response = await fetch(`${bridge.url}${path}`, {
      method: init?.method ?? "GET",
      cache: "no-store",
      headers: {
        ...(init?.body != null ? { "content-type": "application/json" } : {}),
        ...init?.headers,
        "x-lunery-desktop-token": bridge.token,
      },
      body: init?.body,
      signal: AbortSignal.timeout(init?.timeoutMs ?? 15000),
    });
  } catch {
    if (onUnreachable) return onUnreachable();
    return NextResponse.json(
      { error: "Desktop runtime bridge is not available" },
      { status: 404 },
    );
  }

  return new NextResponse(await response.text(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

export function bridgeFetch(
  bridge: DesktopBridge,
  path: string,
  init?: {
    method?: string;
    body?: BodyInit | null;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<Response> {
  return fetch(`${bridge.url}${path}`, {
    method: init?.method ?? "GET",
    cache: "no-store",
    headers: {
      ...(init?.body != null ? { "content-type": "application/json" } : {}),
      ...init?.headers,
      "x-lunery-desktop-token": bridge.token,
    },
    body: init?.body,
    signal: init?.signal,
  });
}

export async function bridgeErrorText(response: Response): Promise<string> {
  return response.text().catch(() => "");
}

export async function startBridgeDownloadJob(
  bridge: DesktopBridge,
  payload: BridgeDownloadStartPayload,
): Promise<Response> {
  return bridgeFetch(bridge, "/hf-download-start", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getBridgeDownloadStatus(
  bridge: DesktopBridge,
  jobId: string,
): Promise<{ status?: unknown } | null> {
  const response = await bridgeFetch(
    bridge,
    `/hf-download-status?jobId=${encodeURIComponent(jobId)}`,
  ).catch(() => null);
  if (!response?.ok) return null;
  return response.json().catch(() => null) as Promise<{ status?: unknown } | null>;
}
