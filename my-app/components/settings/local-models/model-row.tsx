"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Check, Download, RotateCcw, X, Zap } from "@/components/ui/icons";
import { readResponseError } from "@/lib/client/fetch-json";
import { cn } from "@/lib/utils";
import { modelRunnableState } from "@/lib/hf-model-catalog";
import { useHfDownload } from "@/hooks/use-hf-download";
import { useDesktopLocalRuntimes } from "@/hooks/use-desktop-available";
import type { HardwareInfo } from "@/lib/desktop-runtime";
import type { HubModelEntry, ModelInstallStatus, QueueEntry, UiState } from "./types";
import { MODEL_DETAILS, type CopyShape } from "./copy";
import {
  fetchInstallStatuses,
  formatGB,
  isActiveQueueStatus,
  normalizeQueueStatus,
  runtimeAvailable,
} from "./catalog-utils";

function StateBadge({ state, copy }: { state: UiState; copy: CopyShape }) {
  if (state === "downloaded") {
    return (
      <Badge variant="successSoft">
        <Check className="h-3 w-3" />
        {copy.stateLabels.downloaded}
      </Badge>
    );
  }
  if (state === "downloading") {
    return (
      <Badge variant="gold">
        <Zap className="h-3 w-3" />
        {copy.stateLabels.downloading}
      </Badge>
    );
  }
  if (state === "partial") {
    return <Badge variant="gold">{copy.stateLabels.partial}</Badge>;
  }
  if (state === "error") {
    return <Badge variant="destructive">{copy.stateLabels.error}</Badge>;
  }
  if (state === "missing_runtime") {
    return (
      <Badge variant="outline" className="border-(--warning)/40 bg-(--warning-soft) text-(--warning)">
        {copy.stateLabels.missing_runtime}
      </Badge>
    );
  }
  if (state === "hardware_unfit") {
    return (
      <Badge variant="outline" className="text-(--text-muted)">
        {copy.stateLabels.hardware_unfit}
      </Badge>
    );
  }
  if (state === "canceled") {
    return (
      <Badge variant="outline" className="text-(--text-muted)">
        {copy.stateLabels.canceled}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-(--text-muted)">
      {copy.stateLabels.not_downloaded}
    </Badge>
  );
}

// Memoized: the install-queue progress ticks ~every 1.5s and only mutates a
// single job's entry. Without memo, every tick re-rendered the entire catalog
// list. With stable callbacks/props from the parent, only the row whose
// `importQueueEntry` actually changed re-renders now.
function ModelRowImpl({
  entry,
  hw,
  diskGb,
  installStatus,
  runtimes,
  activeLlamaPath,
  copy,
  detailsLocale,
  onStatusChange,
  onActivated,
  onQueueChange,
  onResumeImport,
  onOpenDiagnostics,
  importQueueEntry,
}: {
  entry: HubModelEntry;
  hw: HardwareInfo | null;
  diskGb: number;
  installStatus: ModelInstallStatus | undefined;
  runtimes: ReturnType<typeof useDesktopLocalRuntimes>;
  activeLlamaPath: string | null;
  copy: CopyShape;
  detailsLocale: keyof typeof MODEL_DETAILS;
  onStatusChange: () => Promise<void>;
  onActivated?: (modelId: string) => Promise<void>;
  onQueueChange: (entry: QueueEntry) => void;
  onResumeImport: (entry: HubModelEntry) => Promise<void>;
  onOpenDiagnostics: () => void;
  importQueueEntry?: QueueEntry;
}) {
  const dl = useHfDownload();
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const readyReportedRef = useRef(false);

  useEffect(() => {
    if (dl.status === "ready" && !readyReportedRef.current) {
      readyReportedRef.current = true;
      void onStatusChange();
    }
    if (dl.status !== "ready") readyReportedRef.current = false;
  }, [dl.status, onStatusChange]);
  useEffect(() => {
    if (dl.status === "idle" || dl.status === "unknown") return;
    onQueueChange({
      id: entry.id,
      label: entry.label,
      status: normalizeQueueStatus(dl.status),
      percent: dl.percent,
      fileIndex: dl.fileIndex,
      fileCount: dl.fileCount,
      speedBps: dl.speedBps,
      error: dl.error,
    });
  }, [dl.error, dl.fileCount, dl.fileIndex, dl.percent, dl.speedBps, dl.status, entry.id, entry.label, onQueueChange]);

  const installed = installStatus?.installed || dl.status === "ready";
  const partial = Boolean(installStatus?.partial && !installed);
  const isActive = entry.runtimeTarget === "llama-cpp" &&
    (entry.modelPath
      ? activeLlamaPath === entry.modelPath
      : Boolean(entry.fileName && activeLlamaPath?.endsWith(entry.fileName)));
  const activeImportDownload = Boolean(importQueueEntry && isActiveQueueStatus(importQueueEntry.status));
  const canResumeImportedDownload = Boolean(
    entry.imported &&
      entry.source === "huggingface-url" &&
      entry.url &&
      entry.runtimeTarget &&
      !installed &&
      !activeImportDownload,
  );
  const importedUnavailable = Boolean(entry.imported && !installed && !canResumeImportedDownload);

  const baseState = modelRunnableState(entry, hw, installed || isActive, runtimeAvailable(entry, runtimes));
  const effectiveState: UiState =
    dl.status === "downloading" || dl.status === "queued" || activeImportDownload || activating
      ? "downloading"
      : dl.status === "error"
        ? "error"
        : dl.status === "canceled"
          ? "canceled"
          : partial
            ? "partial"
            : baseState;

  const neededDisk = Math.ceil(entry.sizeBytes / 1_073_741_824);
  const diskOk = diskGb === 0 || diskGb >= neededDisk;
  const hardwareUnfit = baseState === "hardware_unfit";
  const blocked = hardwareUnfit || !diskOk;
  const canRunInline = entry.runtimeTarget === "llama-cpp";

  function disabledReason(): string | undefined {
    if (!diskOk) return copy.disabledDisk(neededDisk);
    if (entry.requiresAppleSilicon && hw && !hw.apple_silicon) return copy.disabledAppleSilicon;
    if (hw && hw.ram_gb < entry.minRamGb) return copy.disabledNoRam(entry.minRamGb);
    return undefined;
  }

  async function refreshInstalledStatus(): Promise<ModelInstallStatus | undefined> {
    const statuses = await fetchInstallStatuses();
    return statuses[entry.id];
  }

  async function activateLlama() {
    setActivating(true);
    setActivationError(null);
    try {
      const response = await fetch("/api/desktop-runtime/llama", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId: entry.id }),
      });
      if (!response.ok) {
        // Surface the specific reason (file missing / permission denied /
        // engine refused) instead of silently leaving the run button inert.
        setActivationError(await readResponseError(response, copy.activateFailed));
        return;
      }
      await onStatusChange();
      await onActivated?.(entry.id);
    } catch {
      setActivationError(copy.activateFailed);
    } finally {
      setActivating(false);
    }
  }

  async function installThenMaybeRun() {
    if (blocked || importedUnavailable || activeImportDownload) return;
    if (canResumeImportedDownload) {
      await onResumeImport(entry);
      return;
    }
    if (!installed) {
      await dl.start(entry.id);
      const status = await refreshInstalledStatus();
      await onStatusChange();
      if (!status?.installed || entry.runtimeTarget !== "llama-cpp") return;
    }
    if (entry.runtimeTarget === "llama-cpp") {
      await activateLlama();
    }
  }

  const progress = activeImportDownload && importQueueEntry
    ? importQueueEntry
    : {
        percent: dl.percent,
        speedBps: dl.speedBps,
        fileIndex: dl.fileIndex,
        fileCount: dl.fileCount,
      };
  const showProgress = effectiveState === "downloading";
  const primaryLabel = isActive
    ? copy.primaryRunning
    : installed
      ? canRunInline
        ? copy.primaryRun
        : copy.primaryReadyStudio
      : canResumeImportedDownload || partial
        ? copy.primaryResume
        : dl.status === "canceled"
        ? copy.primaryResume
        : canRunInline
          ? copy.primaryInstallRun
          : copy.primaryInstall;
  const details = MODEL_DETAILS[detailsLocale][entry.id as keyof (typeof MODEL_DETAILS)["en"]];

  return (
    <div
      className={cn(
        "flex flex-col gap-3 py-3",
        hardwareUnfit && "opacity-55",
      )}
      title={hardwareUnfit ? disabledReason() : undefined}
    >
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 text-xs font-semibold text-(--text-primary)">{entry.label}</p>
            {isActive && <Badge variant="successSoft">{copy.primaryRunning}</Badge>}
            {entry.recommended && <Badge variant="gold">{copy.filters.recommended}</Badge>}
          </div>
          {details ? (
            <p className="mt-1 line-clamp-1 text-xs text-(--text-secondary)">{details.bestFor}</p>
          ) : null}
          <p className="mt-1 text-xs text-(--text-muted)">{formatGB(entry.sizeBytes)}</p>
          {effectiveState === "missing_runtime" && (
            <p className="mt-2 text-xs text-(--warning)">{copy.runtimeMissing}</p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <StateBadge state={isActive ? "downloaded" : effectiveState} copy={copy} />

          {effectiveState === "downloading" && activeImportDownload ? (
            <Button type="button" size="sm" disabled>
              <Zap className="h-3 w-3" />
              {copy.stateLabels.downloading}
            </Button>
          ) : effectiveState === "downloading" ? (
            <Button type="button" size="sm" variant="ghostMuted" onClick={() => void dl.cancel()}>
              <X className="h-3 w-3" />
              {copy.actionCancel}
            </Button>
          ) : effectiveState === "error" ? (
            <Button type="button" size="sm" onClick={() => void installThenMaybeRun()}>
              <RotateCcw className="h-3 w-3" />
              {copy.actionRetry}
            </Button>
          ) : effectiveState === "missing_runtime" ? (
            <Button type="button" size="sm" variant="outline" onClick={onOpenDiagnostics}>
              <Zap className="h-3 w-3" />
              {copy.primaryDiagnostics}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={blocked || importedUnavailable || activating || (installed && !canRunInline) || isActive}
              title={blocked ? disabledReason() : undefined}
              onClick={() => void installThenMaybeRun()}
            >
              {installed ? <Zap className="h-3 w-3" /> : <Download className="h-3 w-3" />}
              {primaryLabel}
            </Button>
          )}
        </div>
      </div>

      {showProgress && (
        <div className="space-y-1">
          <Progress
            value={progress.percent ?? 33}
            className={cn(
              "h-1.5 bg-(--bg-glass)",
              progress.percent === null && "animate-pulse",
            )}
          />
          <div className="flex items-center justify-between gap-3 text-xs text-(--text-muted)">
            <span>{copy.installingPercent(progress.percent)}</span>
            {progress.speedBps > 0 && <span>{copy.speed(progress.speedBps)}</span>}
          </div>
          {progress.fileCount > 1 && (
            <p className="text-xs text-(--text-muted)">
              {copy.fileProgress(progress.fileIndex + 1, progress.fileCount)}
            </p>
          )}
        </div>
      )}

      {effectiveState === "error" && dl.error && (
        <p className="text-xs text-(--destructive)">{dl.error}</p>
      )}

      {activationError && (
        <p className="text-xs text-(--destructive)">{activationError}</p>
      )}
    </div>
  );
}

export const ModelRow = memo(ModelRowImpl);
