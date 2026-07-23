import { useDesktopLocalRuntimes } from "@/hooks/use-desktop-available";
import {
  fitsHardware,
  type ModelCapability,
} from "@/lib/hf-model-catalog";
import type { AccelInfo, HardwareInfo } from "@/lib/desktop-runtime";
import type {
  ExternalRuntimeModel,
  HubModelEntry,
  InstallStatusMap,
  ModelInstallStatus,
  RuntimeInstallEntry,
  QueueStatus,
  StatusFilter,
} from "./types";

// Pill tabs for the catalog: image-first (the primary creative surface), then
// the text planner, then vision. One category is shown at a time so the catalog
// is never a long stacked scroll.
export const CATEGORY_TABS: ModelCapability[] = ["image-gen", "planner-llm", "vision"];
export const STATUS_FILTERS: StatusFilter[] = ["all", "recommended", "installed", "compatible"];
// We only detect Ollama as a first-class external runtime. LM Studio, ComfyUI,
// and any other local server can host an OpenAI-compatible endpoint, which users
// connect through Settings → Providers → "OpenAI compatible" (custom base URL).
// Keeping a single, clean local-LLM entry avoids pushing users to install extra
// power-user apps and keeps the surface aligned with the local-first positioning.
export const EXTERNAL_RUNTIMES = [
  { id: "ollama", label: "Ollama", endpoint: "http://127.0.0.1:11434" },
] as const;
const EXTERNAL_RUNTIME_STORAGE_KEY = "lunerylab.detectedLocalRuntimes.v1";

const QUEUE_STATUSES = new Set<QueueStatus>(["queued", "downloading", "ready", "error", "canceled"]);
const ACTIVE_QUEUE_STATUSES = new Set<QueueStatus>(["queued", "downloading"]);

export function normalizeQueueStatus(status: string): QueueStatus {
  return QUEUE_STATUSES.has(status as QueueStatus) ? (status as QueueStatus) : "error";
}

export function isActiveQueueStatus(status: QueueStatus): boolean {
  return ACTIVE_QUEUE_STATUSES.has(status);
}

export function formatGB(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

export function isHardwareFit(entry: HubModelEntry, hw: HardwareInfo | null): boolean {
  return fitsHardware(entry, hw);
}

function compareFirstRunImageModels(a: HubModelEntry, b: HubModelEntry): number {
  const speed = Number(b.speedTier === "fast") - Number(a.speedTier === "fast");
  if (speed !== 0) return speed;
  return a.sizeBytes - b.sizeBytes;
}

export function selectQuickStartImageModels({
  entries,
  installStatuses,
  hw,
  limit = 4,
}: {
  entries: readonly HubModelEntry[];
  installStatuses: InstallStatusMap;
  hw: HardwareInfo | null;
  limit?: number;
}): HubModelEntry[] {
  const imageEntries = entries.filter((entry) => entry.capability === "image-gen");
  const installedImage = imageEntries.filter(
    (entry) => installStatuses[entry.id]?.installed,
  );
  if (installedImage.length > 0) return installedImage.slice(0, limit);

  const fit = imageEntries
    .filter((entry) => isHardwareFit(entry, hw))
    .toSorted(compareFirstRunImageModels);
  const pool = fit.length > 0 ? fit : imageEntries.toSorted(compareFirstRunImageModels);
  // First run is a recommendation, not a catalog. Showing several equally
  // prominent install actions makes the setup decision harder and breaks the
  // one-primary-action rule. The complete catalog remains directly below.
  return pool.slice(0, Math.min(limit, 1));
}

export function searchText(entry: HubModelEntry): string {
  return [
    entry.label,
    entry.hfRepo,
    entry.fileName,
    entry.modelPath ?? "",
    entry.imported ? "imported local path custom" : "",
    entry.format,
    entry.runtimeTarget,
    entry.capability,
    entry.freshnessNote,
    entry.speedTier,
    entry.recommended ? "current highlighted" : "",
    ...entry.searchAliases,
    ...entry.useCaseTags,
  ]
    .join(" ")
    .toLowerCase();
}

export function importedStatusToEntry(status: ModelInstallStatus): HubModelEntry | null {
  if (!status.imported || !status.runtimeTarget || !status.capability || !status.format) return null;
  const fileName = status.fileName || status.modelPath?.split("/").pop() || status.id;
  const sizeBytes = Math.max(status.totalBytes || 0, status.installedBytes || 0);
  return {
    id: status.id,
    sourceUrl: status.url ?? status.modelPath ?? "",
    checkedAt: new Date().toISOString().slice(0, 10),
    label: status.label || fileName,
    hfRepo: "",
    fileName,
    format: status.format,
    sizeBytes,
    sha256: null,
    minRamGb: status.runtimeTarget === "sd-cpp" || status.runtimeTarget === "comfyui" ? 8 : 4,
    requiresAppleSilicon: false,
    runtimeTarget: status.runtimeTarget,
    capability: status.capability,
    searchAliases: ["imported", "local", "custom", status.source ?? "", status.modelPath ?? ""],
    recommended: false,
    sourceEvidence: [
      {
        label: status.source === "local-path" ? "User imported local model" : "User imported Hugging Face URL",
        url: status.url ?? status.modelPath ?? "",
        lastVerifiedAt: new Date().toISOString().slice(0, 10),
      },
    ],
    freshnessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    freshnessNote:
      "Imported model metadata is user-provided; refresh against the upstream source before turning it into a catalog recommendation.",
    useCaseTags: status.source === "local-path" ? ["imported"] : ["imported", "external-runtime"],
    speedTier: "balanced",
    offlineReady: status.source === "local-path",
    downloadUrl: "",
    imported: true,
    source: status.source,
    modelPath: status.modelPath,
    url: status.url,
    jobId: status.jobId,
    importStatus: status.importStatus,
  };
}

export async function fetchInstallStatuses(): Promise<InstallStatusMap> {
  const response = await fetch("/api/desktop-runtime/models/status", { cache: "no-store" });
  if (!response.ok) return {};
  const payload = (await response.json()) as { models?: ModelInstallStatus[] };
  return Object.fromEntries((payload.models ?? []).map((model) => [model.id, model]));
}

export function readStoredExternalRuntimes(): ExternalRuntimeModel[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(EXTERNAL_RUNTIME_STORAGE_KEY) ?? "[]") as ExternalRuntimeModel[];
    return Array.isArray(parsed) ? parsed.filter((item) => Array.isArray(item.models)) : [];
  } catch {
    return [];
  }
}

export function writeStoredExternalRuntimes(items: ExternalRuntimeModel[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(EXTERNAL_RUNTIME_STORAGE_KEY, JSON.stringify(items));
}

export function runtimeAvailable(entry: HubModelEntry, runtimes: ReturnType<typeof useDesktopLocalRuntimes>): boolean | undefined {
  if (entry.runtimeTarget === "llama-cpp") return true;
  const runtime = runtimes?.find((item) => item.id === entry.runtimeTarget);
  if (!runtime) return undefined;
  if (entry.runtimeTarget === "sd-cpp") return runtime.status === "ready";
  return runtime.status === "ready" || runtime.status === "ready-to-connect";
}

export function isAccelMatch(entry: HubModelEntry, accel: AccelInfo | null): boolean {
  if (!accel) return false;
  switch (accel.gpu) {
    case "metal":
      return entry.requiresAppleSilicon || entry.runtimeTarget === "sd-cpp" || entry.runtimeTarget === "llama-cpp";
    case "cuda":
    case "vulkan":
      // Image kits (sd-cpp) and large LLMs benefit most on discrete GPUs.
      return entry.runtimeTarget === "sd-cpp" || entry.runtimeTarget === "llama-cpp";
    default:
      return false;
  }
}

export function accelChipClass(gpu: string): string {
  switch (gpu) {
    case "metal":
    case "cuda":
      return "bg-(--accent-glow-soft) text-(--accent-glow)";
    case "vulkan":
      return "border-(--warning)/40 bg-(--warning-soft) text-(--warning)";
    default:
      return "bg-(--bg-glass) text-(--text-muted)";
  }
}

const RUNTIME_INSTALL_URLS: Record<string, string> = {
  ollama: "https://ollama.com/download",
};

export function buildRuntimeInstallList(
  bridgeRuntimes: ReturnType<typeof useDesktopLocalRuntimes>,
  detected: ExternalRuntimeModel[],
): RuntimeInstallEntry[] {
  return EXTERNAL_RUNTIMES.map((rt) => {
    const bridge = bridgeRuntimes?.find((b) => b.id === rt.id);
    const detectedEntry = detected.find((d) => d.runtimeId === rt.id);
    const installed = Boolean(bridge?.installed);
    const running = Boolean(detectedEntry); // detected = probed and answered
    return {
      id: rt.id,
      label: rt.label,
      endpoint: rt.endpoint,
      installed,
      running,
      modelsDetected: detectedEntry?.models.length ?? 0,
      latencyMs: detectedEntry?.latencyMs ?? null,
      installUrl: RUNTIME_INSTALL_URLS[rt.id] ?? "https://huggingface.co/",
      // Only ollama / lm-studio have known launch paths.
      launchable: rt.id === "ollama" || rt.id === "lm-studio",
    };
  });
}
