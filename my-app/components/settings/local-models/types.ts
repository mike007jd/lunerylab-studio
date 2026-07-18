import type {
  HfModelEntry,
  ModelCapability,
  ModelFormat,
  ModelRunnableState,
  ModelRuntimeTarget,
} from "@/lib/hf-model-catalog";

export type StatusFilter = "all" | "recommended" | "installed" | "compatible";

export interface ModelInstallStatus {
  id: string;
  label?: string;
  imported?: boolean;
  source?: "local-path" | "huggingface-url";
  runtimeTarget?: ModelRuntimeTarget;
  capability?: ModelCapability;
  format?: ModelFormat;
  fileName?: string;
  modelPath?: string;
  url?: string;
  jobId?: string;
  importStatus?: "ready" | "queued";
  installed: boolean;
  partial: boolean;
  installedFiles: number;
  fileCount: number;
  installedBytes: number;
  totalBytes: number;
  missingFiles: string[];
}

export type HubModelEntry = HfModelEntry & {
  imported?: boolean;
  source?: "local-path" | "huggingface-url";
  modelPath?: string;
  url?: string;
  jobId?: string;
  importStatus?: "ready" | "queued";
};

export type InstallStatusMap = Record<string, ModelInstallStatus>;

export type QueueStatus = "queued" | "downloading" | "ready" | "error" | "canceled";

export interface QueueEntry {
  id: string;
  label: string;
  status: QueueStatus;
  percent: number | null;
  fileIndex: number;
  fileCount: number;
  speedBps: number;
  error: string | null;
}

export interface ExternalRuntimeModel {
  runtimeId: string;
  runtimeLabel: string;
  endpoint: string;
  models: string[];
  latencyMs: number;
}

export type RuntimeTargetOption = Extract<ModelRuntimeTarget, "llama-cpp" | "sd-cpp" | "ollama" | "lm-studio" | "comfyui">;

export type UiState = ModelRunnableState | "partial" | "downloading" | "error" | "canceled" | "planned";

/** External runtime install state — drives the three-state UX in the panel. */
export interface RuntimeInstallEntry {
  id: string;
  label: string;
  endpoint: string;
  installed: boolean;
  running: boolean;
  modelsDetected: number;
  latencyMs: number | null;
  installUrl: string;
  /** True only for runtimes we know how to launch (ollama, lm-studio). */
  launchable: boolean;
}
