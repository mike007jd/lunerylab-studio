import { HttpError, fetchJson } from "@/lib/client/fetch-json";
import type { SdProgress, SdProgressResponse } from "@/lib/types/sd-progress";

const TERMINAL_PHASES = new Set<SdProgress["phase"]>([
  "completed",
  "canceled",
  "failed",
]);

export function createPreparingProgress(runId: string, totalImages: number): SdProgress {
  const now = Date.now();
  return {
    runId,
    phase: "preparing",
    currentImage: totalImages > 0 ? 1 : 0,
    totalImages,
    step: null,
    totalSteps: null,
    secondsPerStep: null,
    startedAtMs: now,
    updatedAtMs: now,
  };
}

export function sdProgressPercent(progress: SdProgress): number | null {
  if (
    progress.phase !== "sampling" ||
    progress.step == null ||
    progress.totalSteps == null ||
    progress.totalSteps <= 0
  ) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round((progress.step / progress.totalSteps) * 100)));
}

export function estimateSdRemainingSeconds(progress: SdProgress): number | null {
  if (
    progress.phase !== "sampling" ||
    progress.step == null ||
    progress.totalSteps == null ||
    progress.secondsPerStep == null ||
    progress.secondsPerStep <= 0
  ) {
    return null;
  }
  const currentImageSteps = Math.max(0, progress.totalSteps - progress.step);
  const laterImages = Math.max(0, progress.totalImages - progress.currentImage);
  const remainingSteps = currentImageSteps + laterImages * progress.totalSteps;
  return Math.ceil(remainingSteps * progress.secondsPerStep);
}

export function isRequestAbortedError(error: unknown): boolean {
  if (error instanceof HttpError) {
    const payload = error.payload as { code?: unknown } | null;
    return payload?.code === "request_aborted";
  }
  return error instanceof Error && error.name === "AbortError";
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollSdProgress({
  runId,
  signal,
  onProgress,
  intervalMs = 1_000,
  read = fetchJson<SdProgressResponse>,
}: {
  runId: string;
  signal: AbortSignal;
  onProgress: (progress: SdProgress) => void;
  intervalMs?: number;
  read?: (input: RequestInfo | URL, init?: RequestInit) => Promise<SdProgressResponse>;
}): Promise<void> {
  while (!signal.aborted) {
    try {
      const payload = await read(
        `/api/desktop-runtime/sd/progress?runId=${encodeURIComponent(runId)}`,
        { signal },
      );
      if (payload.progress?.runId === runId) {
        onProgress(payload.progress);
        if (TERMINAL_PHASES.has(payload.progress.phase)) return;
      }
    } catch {
      if (signal.aborted) return;
      // Progress is advisory. A transient read failure must not fail generation.
    }
    await abortableDelay(intervalMs, signal);
  }
}

export async function requestSdCancellation(runId: string): Promise<void> {
  const response = await fetchJson<{ canceled: boolean }>("/api/desktop-runtime/sd/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId }),
  });
  if (!response.canceled) {
    throw new Error("Native image generation did not stop.");
  }
}
