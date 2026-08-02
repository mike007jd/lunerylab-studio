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

export interface BridgeDownloadJob {
  jobId: string;
  status: string;
  destination: string;
}

export type BridgeDownloadJobsErrorCode =
  | "bridge_timeout"
  | "bridge_aborted"
  | "bridge_unreachable"
  | "bridge_rejected"
  | "invalid_response";

export class BridgeDownloadJobsError extends Error {
  readonly retryable = true;

  constructor(
    readonly code: BridgeDownloadJobsErrorCode,
    message: string,
    readonly bridgeStatus?: number,
  ) {
    super(message);
    this.name = "BridgeDownloadJobsError";
  }
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
 * payload. This wrapper distinguishes a timeout from an unreachable bridge so
 * callers receive a retryable typed error instead of confusing either case
 * with "desktop mode is absent". Pass `onUnreachable` to customise that
 * payload (e.g. status polling wants `{ available: false }`).
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
  } catch (error) {
    if (onUnreachable) return onUnreachable();
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return NextResponse.json(
      {
        error: timedOut
          ? "Desktop runtime bridge timed out"
          : "Desktop runtime bridge is unreachable",
        code: timedOut ? "bridge_timeout" : "bridge_unreachable",
        retryable: true,
      },
      { status: timedOut ? 504 : 503 },
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

/** Hard deadline for bridge download start control calls. */
export const BRIDGE_DOWNLOAD_START_TIMEOUT_MS = 15_000;

/** Hard deadline for bridge download status probes. */
export const BRIDGE_DOWNLOAD_PROBE_TIMEOUT_MS = 15_000;

export type BridgeDownloadAmbiguityCode =
  | "bridge_timeout"
  | "bridge_unreachable"
  | "bridge_start_unknown";

/**
 * Typed control-plane failure for start/status bridge calls.
 *
 * Timeout and unreachable outcomes are retryable ambiguity: the bridge may
 * already own the client-supplied jobId. Callers must not treat these as
 * definitive rejection or local cancellation.
 */
export class BridgeDownloadControlError extends Error {
  readonly code: BridgeDownloadAmbiguityCode;
  readonly retryable: true;
  readonly jobId?: string;

  constructor(
    message: string,
    options: {
      code: BridgeDownloadAmbiguityCode;
      jobId?: string;
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BridgeDownloadControlError";
    this.code = options.code;
    this.retryable = true;
    this.jobId = options.jobId;
  }
}

export type BridgeDownloadProbeResult =
  | {
      outcome: "observed";
      jobId: string;
      status: string;
      body: { status?: unknown; [key: string]: unknown };
    }
  | { outcome: "not_found"; jobId: string }
  | {
      outcome: "ambiguous";
      jobId: string;
      code: BridgeDownloadAmbiguityCode;
      cause?: unknown;
    };

function bridgeDeadlineSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
}

function classifyBridgeControlFailure(
  error: unknown,
  callerSignal?: AbortSignal,
): BridgeDownloadAmbiguityCode | "caller_aborted" {
  if (callerSignal?.aborted) return "caller_aborted";
  if (error instanceof Error && error.name === "TimeoutError") return "bridge_timeout";
  // AbortSignal.any may surface the timeout as AbortError whose reason is TimeoutError.
  if (error instanceof Error && error.name === "AbortError") {
    const reason = (error as { cause?: unknown }).cause;
    if (reason instanceof Error && reason.name === "TimeoutError") return "bridge_timeout";
    if (!callerSignal) return "bridge_timeout";
  }
  return "bridge_unreachable";
}

function toBridgeControlError(
  error: unknown,
  options: { jobId?: string; callerSignal?: AbortSignal },
): BridgeDownloadControlError {
  const code = classifyBridgeControlFailure(error, options.callerSignal);
  if (code === "caller_aborted") {
    // Preserve the caller's abort as a plain Error so AbortSignal semantics stay intact.
    throw error instanceof Error ? error : new Error("Bridge request aborted", { cause: error });
  }
  return new BridgeDownloadControlError(
    code === "bridge_timeout"
      ? "Desktop runtime bridge timed out"
      : "Desktop runtime bridge is unreachable",
    { code, jobId: options.jobId, cause: error },
  );
}

/**
 * Start a bridge download with a hard deadline.
 *
 * Optional `signal` is combined with the deadline via AbortSignal.any — the
 * caller signal is never replaced. Timeout/unreachable throw
 * BridgeDownloadControlError (retryable ambiguity). An HTTP rejection body is
 * returned as a normal Response for callers to treat as definitive.
 */
export async function startBridgeDownloadJob(
  bridge: DesktopBridge,
  payload: BridgeDownloadStartPayload,
  init?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<Response> {
  try {
    return await bridgeFetch(bridge, "/hf-download-start", {
      method: "POST",
      body: JSON.stringify(payload),
      signal: bridgeDeadlineSignal(
        init?.timeoutMs ?? BRIDGE_DOWNLOAD_START_TIMEOUT_MS,
        init?.signal,
      ),
    });
  } catch (error) {
    throw toBridgeControlError(error, {
      jobId: payload.jobId,
      callerSignal: init?.signal,
    });
  }
}

/**
 * Probe bridge download status with a hard deadline and typed ownership outcome.
 *
 * `observed` means the bridge reported a job snapshot. `not_found` is a
 * definitive absence. `ambiguous` covers timeout/unreachable — ownership under
 * the known jobId must stay non-terminal.
 */
export async function probeBridgeDownloadJob(
  bridge: DesktopBridge,
  jobId: string,
  init?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<BridgeDownloadProbeResult> {
  let response: Response;
  try {
    response = await bridgeFetch(
      bridge,
      `/hf-download-status?jobId=${encodeURIComponent(jobId)}`,
      {
        signal: bridgeDeadlineSignal(
          init?.timeoutMs ?? BRIDGE_DOWNLOAD_PROBE_TIMEOUT_MS,
          init?.signal,
        ),
      },
    );
  } catch (error) {
    try {
      const controlError = toBridgeControlError(error, {
        jobId,
        callerSignal: init?.signal,
      });
      return {
        outcome: "ambiguous",
        jobId,
        code: controlError.code,
        cause: error,
      };
    } catch (aborted) {
      throw aborted;
    }
  }

  if (response.status === 404) {
    return { outcome: "not_found", jobId };
  }
  if (!response.ok) {
    return {
      outcome: "ambiguous",
      jobId,
      code: "bridge_start_unknown",
      cause: new Error(`HTTP ${response.status}`),
    };
  }

  const body = (await response.json().catch(() => null)) as
    | { status?: unknown; [key: string]: unknown }
    | null;
  if (!body || typeof body.status !== "string") {
    return {
      outcome: "ambiguous",
      jobId,
      code: "bridge_start_unknown",
      cause: new Error("Bridge status payload missing status"),
    };
  }
  if (body.status === "unknown") {
    return { outcome: "not_found", jobId };
  }
  return { outcome: "observed", jobId, status: body.status, body };
}

/**
 * Source-compatible status helper for existing imported-model callsites.
 * Uses probeBridgeDownloadJob under the hood; null means not observed
 * (missing, timeout, or unreachable).
 */
export async function getBridgeDownloadStatus(
  bridge: DesktopBridge,
  jobId: string,
  init?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ status?: unknown } | null> {
  const probe = await probeBridgeDownloadJob(bridge, jobId, init);
  if (probe.outcome !== "observed") return null;
  return probe.body;
}

export async function getBridgeDownloadJobs(
  bridge: DesktopBridge,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<BridgeDownloadJob[]> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  let response: Response;
  try {
    response = await bridgeFetch(bridge, "/hf-download-list", { signal });
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new BridgeDownloadJobsError(
        "bridge_timeout",
        "Desktop runtime bridge timed out while listing downloads.",
      );
    }
    if (options.signal?.aborted) {
      throw new BridgeDownloadJobsError(
        "bridge_aborted",
        "Desktop runtime download listing was aborted.",
      );
    }
    throw new BridgeDownloadJobsError(
      "bridge_unreachable",
      error instanceof Error ? error.message : "Desktop runtime bridge is unreachable.",
    );
  }
  if (!response.ok) {
    throw new BridgeDownloadJobsError(
      "bridge_rejected",
      `Desktop runtime rejected the download listing with status ${response.status}.`,
      response.status,
    );
  }
  const payload = await response.json().catch(() => null) as { jobs?: unknown } | null;
  if (!Array.isArray(payload?.jobs)) {
    throw new BridgeDownloadJobsError(
      "invalid_response",
      "Desktop runtime returned an invalid download listing.",
    );
  }
  const jobs: BridgeDownloadJob[] = [];
  for (const job of payload.jobs) {
    if (!job || typeof job !== "object") {
      throw new BridgeDownloadJobsError(
        "invalid_response",
        "Desktop runtime returned an invalid download job.",
      );
    }
    const candidate = job as Partial<BridgeDownloadJob>;
    if (typeof candidate.jobId !== "string"
      || typeof candidate.status !== "string"
      || typeof candidate.destination !== "string") {
      throw new BridgeDownloadJobsError(
        "invalid_response",
        "Desktop runtime returned an invalid download job.",
      );
    }
    jobs.push(candidate as BridgeDownloadJob);
  }
  return jobs;
}
