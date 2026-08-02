import { findHfModelEntry } from "@/lib/hf-model-catalog";

export type DownloadStatus =
  | "idle"
  | "queued"
  | "downloading"
  | "ready"
  | "error"
  | "canceled"
  | "unknown";

const DOWNLOAD_STATUSES = new Set<DownloadStatus>([
  "idle",
  "queued",
  "downloading",
  "ready",
  "error",
  "canceled",
  "unknown",
]);

export interface DownloadProgress {
  /** Aggregate status across the whole model kit. */
  status: DownloadStatus;
  /** 0-100 aggregate, or null when indeterminate (single-file, no Content-Length). */
  percent: number | null;
  /** Aggregate bytes (completed files + current file received). */
  received: number;
  /** Kit total bytes (0 = unknown). */
  total: number;
  /** Current file download speed in bytes/second. */
  speedBps: number;
  /** Error message when status === "error". */
  error: string | null;
  /** Active jobId of the file currently downloading (null when idle). */
  jobId: string | null;
  /** 0-based index of the file currently downloading. */
  fileIndex: number;
  /** Total files in this model's kit (1 for single-file models). */
  fileCount: number;
}

export interface BridgeDownloadSnapshot {
  status: string;
  received: number;
  total: number;
  error: string | null;
}

export interface HfDownloadKitFile {
  /** File name to request via the route's `file` param (multi-file only). */
  name: string;
  /** Catalog size used for aggregate percent across files. */
  size: number;
}

export interface HfDownloadKit {
  files: HfDownloadKitFile[];
  /** Whole-kit total bytes. */
  total: number;
  /** True when the model has companions (multi-file aggregate progress). */
  multi: boolean;
}

export interface DownloadSpeedSample {
  received: number;
  timestamp: number;
}

export interface BridgeSnapshotReduction {
  progress: DownloadProgress;
  speedSample: DownloadSpeedSample;
  terminalStatus: "ready" | "error" | "canceled" | null;
}

export type HfCancelTerminalStatus = "ready" | "error" | "canceled";

export interface HfCancelOutcome {
  status: HfCancelTerminalStatus;
  snapshot: BridgeDownloadSnapshot | null;
}

type DownloadFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface PendingJob {
  promise: Promise<string | null>;
  resolve: (jobId: string | null) => void;
}

function pendingJob(): PendingJob {
  let resolve!: (jobId: string | null) => void;
  const promise = new Promise<string | null>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function responseMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.trim() || `HTTP ${response.status}`;
}

/** Next/bridge start codes that mean ownership under jobId is still ambiguous. */
export const HF_START_AMBIGUOUS_CODES = new Set([
  "bridge_timeout",
  "bridge_unreachable",
  "bridge_start_unknown",
]);

export type HfDownloadStartOutcome =
  | { kind: "accepted"; jobId: string }
  | { kind: "rejected"; jobId: string; error: string; status: number }
  | { kind: "ambiguous"; jobId: string; error: string; code: string };

export type HfDownloadOwnershipProbe =
  | { kind: "observed"; jobId: string; status: DownloadStatus; snapshot: BridgeDownloadSnapshot }
  | { kind: "missing"; jobId: string }
  | { kind: "ambiguous"; jobId: string; error: string };

function ownsAmbiguousJobId(payloadJobId: unknown, jobId: string): boolean {
  return payloadJobId == null || payloadJobId === jobId;
}

function isAmbiguousStartPayload(
  status: number,
  payload: { code?: unknown; retryable?: unknown; jobId?: unknown; error?: unknown } | null,
  jobId: string,
): boolean {
  if (payload && !ownsAmbiguousJobId(payload.jobId, jobId)) return false;
  if (
    payload?.retryable === true
    && typeof payload.code === "string"
    && HF_START_AMBIGUOUS_CODES.has(payload.code)
  ) {
    return true;
  }
  // Transport-class statuses without a definitive rejection body stay ambiguous
  // under the client-preassigned jobId.
  return status === 503 || status === 504;
}

/**
 * POST the client-preassigned jobId to the Next HF download route.
 *
 * Network loss and retryable ambiguity codes never become `rejected` — the
 * caller retains the known jobId for probe/cancel. Only an actual received
 * definitive rejection is terminal.
 */
export async function requestHfDownloadStart(
  input: { modelId: string; jobId: string; file?: string },
  fetcher: DownloadFetch = fetch,
): Promise<HfDownloadStartOutcome> {
  const { modelId, jobId, file } = input;
  const body =
    file !== undefined && file.length > 0
      ? { modelId, file, jobId }
      : { modelId, jobId };

  let response: Response;
  try {
    response = await fetcher("/api/desktop-runtime/hf-download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (error) {
    return {
      kind: "ambiguous",
      jobId,
      code: "bridge_start_unknown",
      error: error instanceof Error ? error.message : "Download start response was lost.",
    };
  }

  if (response.ok) {
    const ack = (await response.json().catch(() => null)) as { jobId?: unknown } | null;
    if (ack?.jobId != null && ack.jobId !== jobId) {
      return {
        kind: "rejected",
        jobId,
        status: 500,
        error: "Download start returned a mismatched job id.",
      };
    }
    return { kind: "accepted", jobId };
  }

  const payload = (await response.json().catch(() => null)) as {
    error?: unknown;
    code?: unknown;
    retryable?: unknown;
    jobId?: unknown;
  } | null;

  if (isAmbiguousStartPayload(response.status, payload, jobId)) {
    return {
      kind: "ambiguous",
      jobId,
      code: typeof payload?.code === "string" ? payload.code : "bridge_start_unknown",
      error:
        typeof payload?.error === "string" && payload.error.trim()
          ? payload.error
          : `Download start outcome is unknown (HTTP ${response.status}).`,
    };
  }

  return {
    kind: "rejected",
    jobId,
    status: response.status,
    error:
      typeof payload?.error === "string" && payload.error.trim()
        ? payload.error
        : `Failed to start download: HTTP ${response.status}`,
  };
}

/**
 * Probe Next status for a client-owned jobId after an ambiguous start.
 * Hard transport failures stay ambiguous — never invent local cancellation.
 */
export async function probeHfDownloadOwnership(
  jobId: string,
  fetcher: DownloadFetch = fetch,
): Promise<HfDownloadOwnershipProbe> {
  let response: Response;
  try {
    response = await fetcher(
      `/api/desktop-runtime/hf-download/${encodeURIComponent(jobId)}`,
      { cache: "no-store" },
    );
  } catch (error) {
    return {
      kind: "ambiguous",
      jobId,
      error: error instanceof Error ? error.message : "Download status probe failed.",
    };
  }

  if (response.status === 404) {
    return { kind: "missing", jobId };
  }
  if (!response.ok) {
    return {
      kind: "ambiguous",
      jobId,
      error: await responseMessage(response),
    };
  }

  const snapshot = (await response.json().catch(() => null)) as BridgeDownloadSnapshot | null;
  if (!snapshot || typeof snapshot.status !== "string") {
    return { kind: "ambiguous", jobId, error: "Download status payload was incomplete." };
  }
  return {
    kind: "observed",
    jobId,
    status: normalizeDownloadStatus(snapshot.status),
    snapshot: {
      status: normalizeDownloadStatus(snapshot.status),
      received: typeof snapshot.received === "number" ? snapshot.received : 0,
      total: typeof snapshot.total === "number" ? snapshot.total : 0,
      error: typeof snapshot.error === "string" ? snapshot.error : null,
    },
  };
}

/**
 * Resolve a start attempt that may have lost its response.
 * Observed bridge ownership upgrades ambiguity to accepted; missing allows an
 * idempotent same-ID retry; persistent ambiguity stays non-terminal.
 */
export async function resolveHfDownloadStartOwnership(
  input: { modelId: string; jobId: string; file?: string },
  options: {
    fetcher?: DownloadFetch;
    /** When true, retry the start POST once with the same jobId after a miss. */
    retryIdempotentStart?: boolean;
  } = {},
): Promise<HfDownloadStartOutcome> {
  const fetcher = options.fetcher ?? fetch;
  const first = await requestHfDownloadStart(input, fetcher);
  if (first.kind !== "ambiguous") return first;

  const probe = await probeHfDownloadOwnership(input.jobId, fetcher);
  if (probe.kind === "observed") {
    return { kind: "accepted", jobId: input.jobId };
  }

  if (probe.kind === "missing" && options.retryIdempotentStart !== false) {
    const retry = await requestHfDownloadStart(input, fetcher);
    if (retry.kind === "ambiguous") {
      const retryProbe = await probeHfDownloadOwnership(input.jobId, fetcher);
      if (retryProbe.kind === "observed") {
        return { kind: "accepted", jobId: input.jobId };
      }
    }
    return retry;
  }

  return first;
}

export async function requestHfDownloadCancel(
  jobId: string,
  fetcher: DownloadFetch = fetch,
): Promise<void> {
  const response = await fetcher(
    `/api/desktop-runtime/hf-download/${encodeURIComponent(jobId)}`,
    { method: "DELETE", cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`Cancel request failed: ${await responseMessage(response)}`);
  }
  const ack = (await response.json().catch(() => null)) as {
    ok?: unknown;
    cancelRequested?: unknown;
    jobId?: unknown;
  } | null;
  if (ack?.ok !== true || ack.cancelRequested !== true || ack.jobId !== jobId) {
    throw new Error("Cancel request was not acknowledged by the desktop runtime.");
  }
}

export async function waitForHfDownloadTerminal(
  jobId: string,
  options: {
    fetcher?: DownloadFetch;
    sleep?: (milliseconds: number) => Promise<void>;
    pollIntervalMs?: number;
    maxAttempts?: number;
  } = {},
): Promise<BridgeDownloadSnapshot> {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const maxAttempts = options.maxAttempts ?? 120;
  let lastError = "Desktop runtime did not confirm cancellation.";

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetcher(
        `/api/desktop-runtime/hf-download/${encodeURIComponent(jobId)}`,
        { cache: "no-store" },
      );
      if (response.ok) {
        const snapshot = (await response.json()) as BridgeDownloadSnapshot;
        const status = normalizeDownloadStatus(snapshot.status);
        if (status === "ready" || status === "error" || status === "canceled") {
          return { ...snapshot, status };
        }
      } else {
        lastError = await responseMessage(response);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Desktop runtime status request failed.";
    }
    if (attempt + 1 < maxAttempts) await sleep(pollIntervalMs);
  }
  throw new Error(`Cancel confirmation failed: ${lastError}`);
}

/** Coordinates cancel with a start POST that may not have returned its job id.
 * Server truth is authoritative: intent alone never yields terminal canceled.
 */
export class HfDownloadCancelCoordinator {
  private currentJobId: string | null = null;
  private pending: PendingJob | null = null;
  private cancelIntent = false;
  private cancelAttempt: Promise<HfCancelOutcome> | null = null;

  constructor(
    private readonly fetcher: DownloadFetch = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  get cancelRequested(): boolean {
    return this.cancelIntent;
  }

  resetForStart(): void {
    this.cancelIntent = false;
    this.currentJobId = null;
    this.pending?.resolve(null);
    this.pending = null;
    this.cancelAttempt = null;
  }

  prepareJobRequest(): boolean {
    if (this.cancelIntent) return false;
    this.currentJobId = null;
    this.pending = pendingJob();
    return true;
  }

  registerJob(jobId: string): void {
    this.currentJobId = jobId;
    this.pending?.resolve(jobId);
    this.pending = null;
  }

  /**
   * Abandon a start that never obtained a known jobId.
   * Must not be used after registerJob — ambiguous ownership under a
   * client-preassigned id stays cancelable via that id.
   */
  failJobRequest(): void {
    this.pending?.resolve(null);
    this.pending = null;
  }

  finishJob(jobId: string): void {
    if (this.currentJobId === jobId) this.currentJobId = null;
  }

  activeCancelAttempt(): Promise<HfCancelOutcome> | null {
    return this.cancelAttempt;
  }

  requestCancel(): Promise<HfCancelOutcome> {
    if (this.cancelAttempt) return this.cancelAttempt;
    this.cancelIntent = true;
    const attempt = this.runCancel();
    this.cancelAttempt = attempt;
    void attempt.finally(() => {
      if (this.cancelAttempt === attempt) this.cancelAttempt = null;
    }).catch(() => {});
    return attempt;
  }

  private async runCancel(): Promise<HfCancelOutcome> {
    try {
      const jobId = this.currentJobId ?? (this.pending ? await this.pending.promise : null);
      // Between kit files there is no server job to cancel; local intent stops
      // the loop before it starts the next file.
      if (!jobId) return { status: "canceled", snapshot: null };
      await requestHfDownloadCancel(jobId, this.fetcher);
      const snapshot = await waitForHfDownloadTerminal(jobId, {
        fetcher: this.fetcher,
        sleep: this.sleep,
      });
      this.finishJob(jobId);
      return {
        status: snapshot.status as HfCancelTerminalStatus,
        snapshot,
      };
    } catch (error) {
      // A rejected/false/transport acknowledgment leaves the server job active
      // and makes cancel retryable.
      this.cancelIntent = false;
      throw error;
    }
  }
}

export const DOWNLOAD_PROGRESS_INITIAL_STATE: DownloadProgress = {
  status: "idle",
  percent: null,
  received: 0,
  total: 0,
  speedBps: 0,
  error: null,
  jobId: null,
  fileIndex: 0,
  fileCount: 1,
};

export function normalizeDownloadStatus(status: string): DownloadStatus {
  return DOWNLOAD_STATUSES.has(status as DownloadStatus) ? (status as DownloadStatus) : "unknown";
}

export function resolveHfDownloadKit(modelId: string): HfDownloadKit {
  const entry = findHfModelEntry(modelId);
  if (!entry) return { files: [{ name: "", size: 0 }], total: 0, multi: false };

  const companions = entry.companions ?? [];
  if (companions.length === 0) {
    return {
      files: [{ name: entry.fileName, size: entry.sizeBytes }],
      total: entry.sizeBytes,
      multi: false,
    };
  }

  const companionTotal = companions.reduce((sum, companion) => sum + companion.sizeBytes, 0);
  const mainSize = Math.max(0, entry.sizeBytes - companionTotal);
  return {
    files: [
      { name: entry.fileName, size: mainSize },
      ...companions.map((companion) => ({ name: companion.fileName, size: companion.sizeBytes })),
    ],
    total: entry.sizeBytes,
    multi: true,
  };
}

export function measureDownloadSpeed(
  previous: DownloadSpeedSample | null,
  received: number,
  timestamp: number,
): { speedBps: number; speedSample: DownloadSpeedSample } {
  if (!previous) {
    return { speedBps: 0, speedSample: { received, timestamp } };
  }

  const elapsedSeconds = (timestamp - previous.timestamp) / 1000;
  const deltaBytes = received - previous.received;
  const speedBps = elapsedSeconds > 0 ? Math.max(0, Math.round(deltaBytes / elapsedSeconds)) : 0;
  return { speedBps, speedSample: { received, timestamp } };
}

export function reduceBridgeDownloadSnapshot(input: {
  snapshot: BridgeDownloadSnapshot;
  previousSpeedSample: DownloadSpeedSample | null;
  completedBytes: number;
  fileIndex: number;
  jobId: string;
  kit: HfDownloadKit;
  timestamp: number;
}): BridgeSnapshotReduction {
  const { snapshot, previousSpeedSample, completedBytes, fileIndex, jobId, kit, timestamp } = input;
  const { total: kitTotal, multi } = kit;
  const fileCount = kit.files.length;
  const { speedBps, speedSample } = measureDownloadSpeed(previousSpeedSample, snapshot.received, timestamp);

  const aggregateReceived = completedBytes + snapshot.received;
  const percent = multi
    ? kitTotal > 0
      ? Math.min(100, Math.round((aggregateReceived / kitTotal) * 100))
      : null
    : snapshot.total > 0
      ? Math.min(100, Math.round((snapshot.received / snapshot.total) * 100))
      : null;

  const status = normalizeDownloadStatus(snapshot.status);
  return {
    progress: {
      status,
      percent,
      received: multi ? aggregateReceived : snapshot.received,
      total: multi ? kitTotal : snapshot.total,
      speedBps,
      error: snapshot.error ?? null,
      jobId,
      fileIndex,
      fileCount,
    },
    speedSample,
    terminalStatus: status === "ready" || status === "error" || status === "canceled" ? status : null,
  };
}
