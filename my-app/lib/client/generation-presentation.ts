import type { AssetDTO, GenerationResponse } from "@/lib/types/api";

export function formatGenerationOptionsSummary(
  aspectRatio: string,
  count: number,
): string {
  return `${aspectRatio} · ×${count}`;
}

export function resolveCssAspectRatio(
  requestedRatio: string,
  intrinsicWidth?: number | null,
  intrinsicHeight?: number | null,
): string {
  if (
    typeof intrinsicWidth === "number" &&
    intrinsicWidth > 0 &&
    typeof intrinsicHeight === "number" &&
    intrinsicHeight > 0
  ) {
    return `${intrinsicWidth} / ${intrinsicHeight}`;
  }

  const match = requestedRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return "1 / 1";
  return `${match[1]} / ${match[2]}`;
}

type KeyedSingleFlightResult<T> =
  | { started: false }
  | { started: true; value: T };

/**
 * Acquires a key synchronously before invoking an async operation. This closes
 * the same-frame gap where React state has not rendered a disabled control yet.
 */
export function createKeyedSingleFlight() {
  const runningKeys = new Set<string>();

  return {
    isRunning(key: string): boolean {
      return runningKeys.has(key);
    },
    async run<T>(key: string, operation: () => Promise<T>): Promise<KeyedSingleFlightResult<T>> {
      if (runningKeys.has(key)) return { started: false };
      runningKeys.add(key);
      try {
        return { started: true, value: await operation() };
      } finally {
        runningKeys.delete(key);
      }
    },
  };
}

export interface ImageGenerationOutcome {
  status: "succeeded" | "partial" | "failed";
  assets: AssetDTO[];
  warnings: string[];
  succeededCount: number;
  error: string | null;
}

export function resolveImageGenerationOutcome(
  response: GenerationResponse,
  fallbackError: string,
): ImageGenerationOutcome {
  const assets = response.assets ?? [];
  const failed = response.job.status === "FAILED" || assets.length === 0;
  const status = failed
    ? "failed"
    : response.job.status === "PARTIAL"
      ? "partial"
      : "succeeded";

  return {
    status,
    assets,
    warnings: response.warnings ?? [],
    succeededCount: assets.length,
    error: failed ? response.job.errorMessage ?? fallbackError : null,
  };
}
