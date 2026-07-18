export const SD_PROGRESS_PHASES = [
  "preparing",
  "sampling",
  "finalizing",
  "completed",
  "canceled",
  "failed",
] as const;

export type SdProgressPhase = (typeof SD_PROGRESS_PHASES)[number];

export const SD_RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidSdRunId(value: unknown): value is string {
  return typeof value === "string" && SD_RUN_ID_PATTERN.test(value);
}

export interface SdProgress {
  runId: string;
  phase: SdProgressPhase;
  currentImage: number;
  totalImages: number;
  step: number | null;
  totalSteps: number | null;
  secondsPerStep: number | null;
  startedAtMs: number;
  updatedAtMs: number;
}

export interface SdProgressResponse {
  progress: SdProgress | null;
}
