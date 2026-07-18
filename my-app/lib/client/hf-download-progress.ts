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
