"use client";

/** Latest-first Studio results with inline status and per-asset actions. */

import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  Check,
  Download,
  Film,
  Info,
  Loader2,
  RefreshCw,
  X,
} from "@/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AssetImage } from "@/components/ui/asset-image";
import { Button } from "@/components/ui/button";
import type {
  GenerationEntry,
  GenerationMode,
} from "@/components/studio/use-studio-generation-history";
import type { AssetDTO } from "@/lib/types/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/provider";
import { resolveCssAspectRatio } from "@/lib/client/generation-presentation";
import {
  estimateSdRemainingSeconds,
  sdProgressPercent,
} from "@/lib/client/sd-progress";
import type { SdProgress } from "@/lib/types/sd-progress";
import { lunaMotion, lunaVariants } from "@/components/design-system/grammar/motion";

interface PresentedAsset {
  asset: AssetDTO;
  prompt: string;
  position: number;
}

interface GenerationResultsGridProps {
  entries: GenerationEntry[];
  /** Regenerate the same request — parent rebuilds the FormData and re-submits. */
  onRegenerate: (entryId: string) => void;
  /** Send a finished image asset into a Canvas session (creates one as needed). */
  onSendToCanvas: (entryId: string, asset: AssetDTO) => void;
  /** Dismiss a failed entry from the grid. */
  onDismiss: (entryId: string) => void;
  /** Cancel the exact in-flight local image run represented by this entry. */
  onCancel?: (entryId: string) => void;
  /** Native sd-cli progress keyed by Studio history entry id. */
  progressByEntry?: Record<string, SdProgress | undefined>;
  /** Whether a generation is currently in-flight (disables retry buttons). */
  busy?: boolean;
  className?: string;
}

export const RECENT_RESULTS_LIMIT = 12;

export function partitionGenerationResults(
  entries: GenerationEntry[],
  showEarlierResults: boolean,
): { visibleEntries: GenerationEntry[]; earlierCount: number } {
  const earlierCount = Math.max(0, entries.length - RECENT_RESULTS_LIMIT);
  return {
    visibleEntries: showEarlierResults ? entries : entries.slice(0, RECENT_RESULTS_LIMIT),
    earlierCount,
  };
}

/**
 * Trigger a browser download for an asset. We use the existing private API URL
 * (the asset DTO already exposes it) — no need to fetch + blob since the route
 * sets Content-Disposition: attachment behaviour acceptable via the download
 * attribute. If the browser ignores `download` (cross-origin etc.), it still
 * navigates to the asset URL which is a no-worse fallback.
 */
function downloadAsset(asset: AssetDTO) {
  const a = document.createElement("a");
  a.href = asset.url;
  a.download = `lunery-${asset.id}.${(asset.format ?? "png").toLowerCase()}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export const GenerationResultsGrid = memo(function GenerationResultsGrid({
  entries,
  onRegenerate,
  onSendToCanvas,
  onDismiss,
  onCancel,
  progressByEntry = {},
  busy = false,
  className,
}: GenerationResultsGridProps) {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  const [showEarlierResults, setShowEarlierResults] = useState(false);
  const { visibleEntries, earlierCount } = useMemo(
    () => partitionGenerationResults(entries, showEarlierResults),
    [entries, showEarlierResults],
  );

  // Cap comparison at four assets so the modal stays readable.
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const toggleAssetSelect = useCallback((id: string) => {
    setSelectedAssetIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 4) return prev;
      return [...prev, id];
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedAssetIds([]), []);
  const allAssetsById = useMemo(() => {
    const m = new Map<string, PresentedAsset>();
    for (const entry of entries) {
      entry.assets.forEach((asset, index) => {
        m.set(asset.id, { asset, prompt: entry.prompt, position: index + 1 });
      });
    }
    return m;
  }, [entries]);
  // Prune selection when the underlying assets disappear (e.g. dismiss).
  // The rule discourages setState-in-effect; here it is the canonical pattern
  // for "purge derived state when its source set shrinks" — we cannot purge
  // synchronously because the source set is owned by the parent.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedAssetIds((prev) => prev.filter((id) => allAssetsById.has(id)));
  }, [allAssetsById]);
  // Esc / focus-trap / focus-restore are handled by the shadcn Dialog hosting
  // the CompareModal — no manual keydown listener needed.

  const labels = useMemo(() => {
    const historyControls = {
      earlierResults: t("studio.earlierResults"),
      earlierResultsSummary: (count: number) => t("studio.earlierResultsSummary", { count }),
      showEarlierResults: t("studio.showEarlierResults"),
      showRecentResults: t("studio.showRecentResults"),
      openLibrary: t("studio.openLibrary"),
    };
    return {
      heading: t("studio.results.heading"),
      regenerate: t("studio.results.regenerate"),
      sendToCanvas: t("studio.results.sendToCanvas"),
      download: t("common.download"),
      dismiss: t("studio.results.dismiss"),
      running: t("studio.results.running"),
      videoRunning: t("studio.results.videoRunning"),
      canceled: t("studio.results.canceled"),
      cancel: t("common.cancel"),
      preparingElapsed: (seconds: number) =>
        t("studio.results.preparingElapsed", { seconds }),
      samplingProgress: (current: number, total: number, step: number, steps: number, percent: number) =>
        t("studio.results.samplingProgress", { current, total, step, steps, percent }),
      remainingSeconds: (seconds: number) =>
        t("studio.results.remainingSeconds", { seconds }),
      remainingMinutes: (minutes: number) =>
        t("studio.results.remainingMinutes", { minutes }),
      finalizing: t("studio.results.finalizing"),
      failed: t("studio.results.failed"),
      interrupted: t("studio.results.interrupted"),
      retry: t("studio.results.retry"),
      refsCount: (count: number) =>
        t(count === 1 ? "studio.results.referenceSingle" : "studio.results.referenceMultiple", {
          count,
        }),
      select: t("studio.results.select"),
      compareN: (count: number) => t("studio.results.compare", { count }),
      clear: t("studio.results.clear"),
      compareTitle: t("studio.results.compareTitle"),
      partial: (actual: number, expected: number) =>
        t("studio.results.partial", { actual, expected }),
      resultAlt: (position: number, prompt: string) =>
        t("studio.results.resultAlt", { position, prompt }),
      actionForResult: (action: string, position: number) =>
        t("studio.results.actionForResult", { action, position }),
      canvasShort: t("studio.results.canvasShort"),
      ...historyControls,
    };
  }, [t]);

  // Until the first result exists, let the composer own the idle viewport.
  if (entries.length === 0) {
    return null;
  }

  return (
    <section
      data-testid="studio-results-grid"
      aria-label={labels.heading}
      className={cn("mx-auto w-full max-w-5xl space-y-3", className)}
    >
      <div className="flex items-center gap-3 px-1">
        <h2 className="text-xs font-semibold text-(--text-muted)">
          {labels.heading}
        </h2>
        <span className="h-px flex-1 bg-linear-to-r from-transparent via-(--border-subtle) to-transparent" />
      </div>

      <div id="studio-generation-results" className="space-y-5">
        <AnimatePresence initial={false}>
          {visibleEntries.map((entry) => {
            const interrupted = entry.status === "interrupted";
            const canceled = entry.status === "canceled";
            const showFailureCard = entry.status === "failed" || interrupted || canceled;
            return (
            <motion.article
              key={entry.id}
              layout
              variants={lunaVariants.rise}
              initial={reduceMotion ? false : "hidden"}
              animate="visible"
              exit={reduceMotion ? undefined : "exit"}
              transition={reduceMotion ? undefined : lunaMotion.overlay}
              className="rounded-2xl border border-(--border-subtle) bg-(--bg-surface) px-4 py-3 shadow-(--shadow-sm)"
            >
              {/* Prompt + meta row */}
              <header className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm text-(--text-primary)">{entry.prompt}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs font-medium text-(--text-muted)">
                    {entry.mode === "video" ? <Film className="h-3 w-3" /> : null}
                    <span>{entry.aspectRatio}</span>
                    {entry.batchVariants?.length ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>×{entry.batchVariants.length}</span>
                      </>
                    ) : (
                      <>
                        <span aria-hidden>·</span>
                        <span>×{entry.count}</span>
                      </>
                    )}
                    {entry.referenceAssetIds.length > 0 ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>{labels.refsCount(entry.referenceAssetIds.length)}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                {showFailureCard ? (
                  <Button
                    type="button"
                    onClick={() => onDismiss(entry.id)}
                    aria-label={labels.dismiss}
                    variant="ghostMuted"
                    size="icon-xs"
                    className="shrink-0 hover:bg-(--bg-elevated)"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </header>

              {/* Body */}
              {entry.status === "running" ? (
                <RunningCard
                  mode={entry.mode}
                  label={entry.mode === "video" ? labels.videoRunning : labels.running}
                  count={entry.batchVariants?.length || entry.count}
                  aspectRatio={entry.aspectRatio}
                  progress={progressByEntry[entry.id]}
                  progressLabels={labels}
                  onCancel={entry.mode === "image" && onCancel ? () => onCancel(entry.id) : undefined}
                />
              ) : showFailureCard ? (
                <FailedCard
                  error={
                    canceled
                      ? labels.canceled
                      : interrupted
                        ? labels.interrupted
                        : entry.error ?? labels.failed
                  }
                  tone={interrupted || canceled ? "muted" : "destructive"}
                  retryLabel={labels.retry}
                  disabled={busy}
                  onRetry={() => onRegenerate(entry.id)}
                  canRetry={entry.mode !== "video"}
                />
              ) : (
                <div className="space-y-3">
                  {entry.status === "partial" || entry.warnings.length > 0 ? (
                    <Alert className="border-transparent bg-(--warning-soft)">
                      <Info className="h-4 w-4 text-(--warning)" />
                      <AlertDescription className="space-y-1 text-xs text-(--text-secondary)">
                        {entry.status === "partial" ? (
                          <p>{labels.partial(entry.assets.length, entry.count)}</p>
                        ) : null}
                        {entry.warnings.map((warning) => (
                          <p key={warning}>{warning}</p>
                        ))}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  <AssetTile
                    assets={entry.assets}
                    prompt={entry.prompt}
                    aspectRatio={entry.aspectRatio}
                    labels={labels}
                    disabled={busy}
                    onRegenerate={() => onRegenerate(entry.id)}
                    onSendToCanvas={(asset) => onSendToCanvas(entry.id, asset)}
                    selectedAssetIds={selectedAssetIds}
                    onToggleSelect={toggleAssetSelect}
                  />
                </div>
              )}
            </motion.article>
            );
          })}
        </AnimatePresence>
      </div>

      {earlierCount > 0 ? (
        <div className="flex flex-col gap-3 rounded-xl border border-(--border-subtle) bg-(--bg-surface) px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-(--text-primary)">
              {labels.earlierResults}
            </p>
            <p className="mt-0.5 text-xs text-(--text-muted)">
              {labels.earlierResultsSummary(earlierCount)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="mutedOutline"
              size="sm"
              aria-expanded={showEarlierResults}
              aria-controls="studio-generation-results"
              onClick={() => setShowEarlierResults((current) => !current)}
            >
              {showEarlierResults ? labels.showRecentResults : labels.showEarlierResults}
            </Button>
            <Button asChild variant="ghostMuted" size="sm">
              <Link href="/library">{labels.openLibrary}</Link>
            </Button>
          </div>
        </div>
      ) : null}

      {/* Compare floating action bar — surfaces once 2+ assets are picked. */}
      {selectedAssetIds.length >= 2 ? (
        <div
          className="pointer-events-none fixed bottom-6 left-1/2 z-30 -translate-x-1/2"
          aria-live="polite"
        >
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-(--border-subtle) bg-(--bg-surface) px-3 py-2 shadow-(--shadow-lg)">
            <span className="text-xs font-medium text-(--text-secondary)">
              {labels.compareN(selectedAssetIds.length)}
            </span>
            <Button
              type="button"
              onClick={clearSelection}
              variant="ghostMuted"
              size="xs"
            >
              {labels.clear}
            </Button>
            <Button
              type="button"
              onClick={() => setCompareOpen(true)}
              variant="mutedOutline"
              size="xs"
            >
              {labels.compareN(selectedAssetIds.length)} →
            </Button>
          </div>
        </div>
      ) : null}

      <CompareModal
        open={compareOpen}
        onOpenChange={setCompareOpen}
        assets={selectedAssetIds
          .map((id) => allAssetsById.get(id))
          .filter((a): a is PresentedAsset => !!a)}
        title={labels.compareTitle}
        getAlt={labels.resultAlt}
      />
    </section>
  );
});

// ---------------------------------------------------------------------------
// CompareModal — side-by-side viewer for up to 4 selected assets.
// Hosted in the shadcn Dialog primitive, which provides focus trap, Escape,
// aria-modal and focus restore. The labels table still feeds the title.
// ---------------------------------------------------------------------------

function CompareModal({
  open,
  onOpenChange,
  assets,
  title,
  getAlt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assets: PresentedAsset[];
  title: string;
  getAlt: (position: number, prompt: string) => string;
}) {
  const gridCls =
    assets.length === 2
      ? "grid-cols-2"
      : assets.length === 3
      ? "grid-cols-2 sm:grid-cols-3"
      : "grid-cols-2 sm:grid-cols-4";
  return (
    <Dialog open={open && assets.length > 0} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full max-w-[1400px] overflow-hidden bg-(--bg-surface) sm:max-w-[1400px]">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold uppercase tracking-[0.18em] text-(--text-secondary)">
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className={cn("grid gap-3 overflow-y-auto", gridCls)}>
          {assets.map(({ asset, prompt, position }) => (
            <div
              key={asset.id}
              className="overflow-hidden rounded-xl border border-(--border-subtle) bg-(--bg-elevated)"
            >
              <AssetImage
                src={asset.url}
                alt={getAlt(position, prompt)}
                priority
                className="h-auto max-h-[78vh] w-full object-contain"
              />
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sub-components — kept in the same file because they're tightly coupled to
// the grid's layout grammar and never reused elsewhere.
// ---------------------------------------------------------------------------

interface RunningCardProps {
  mode: GenerationMode;
  label: string;
  count: number;
  aspectRatio: string;
  progress?: SdProgress;
  progressLabels: {
    cancel: string;
    preparingElapsed: (seconds: number) => string;
    samplingProgress: (
      current: number,
      total: number,
      step: number,
      steps: number,
      percent: number,
    ) => string;
    remainingSeconds: (seconds: number) => string;
    remainingMinutes: (minutes: number) => string;
    finalizing: string;
  };
  onCancel?: () => void;
}

function RunningCard({
  mode,
  label,
  count,
  aspectRatio,
  progress,
  progressLabels,
  onCancel,
}: RunningCardProps) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!progress || !["preparing", "sampling"].includes(progress.phase)) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [progress]);

  let progressText = label;
  if (progress?.phase === "preparing") {
    const elapsedSeconds = Math.max(0, Math.floor((now - progress.startedAtMs) / 1_000));
    progressText = progressLabels.preparingElapsed(elapsedSeconds);
  } else if (
    progress?.phase === "sampling" &&
    progress.step != null &&
    progress.totalSteps != null
  ) {
    const percent = sdProgressPercent(progress);
    if (percent != null) {
      progressText = progressLabels.samplingProgress(
        progress.currentImage,
        progress.totalImages,
        progress.step,
        progress.totalSteps,
        percent,
      );
      const remainingSeconds = estimateSdRemainingSeconds(progress);
      if (remainingSeconds != null) {
        progressText += ` · ${
          remainingSeconds < 90
            ? progressLabels.remainingSeconds(remainingSeconds)
            : progressLabels.remainingMinutes(Math.ceil(remainingSeconds / 60))
        }`;
      }
    }
  } else if (progress?.phase === "finalizing") {
    progressText = progressLabels.finalizing;
  }

  // For video we show 1 large skeleton; for image we show `count` placeholders
  // so users see the request shape (e.g. 4-grid) immediately.
  const slots = mode === "video" ? 1 : Math.max(1, Math.min(4, count));
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="text-xs text-(--text-secondary)">
          {progressText}
        </p>
        {onCancel ? (
          <Button type="button" variant="mutedOutline" size="xs" onClick={onCancel}>
            <X className="h-3.5 w-3.5" />
            {progressLabels.cancel}
          </Button>
        ) : null}
      </div>
      <div
        className={cn(
          "grid gap-2",
          slots === 1
            ? "grid-cols-1"
            : slots === 2
              ? "grid-cols-2"
              : slots === 3
                ? "grid-cols-2 sm:grid-cols-3"
                : "grid-cols-2 sm:grid-cols-4",
        )}
      >
        {Array.from({ length: slots }).map((_, idx) => (
          <div
            key={idx}
            className="relative overflow-hidden rounded-lg border border-(--border-subtle) bg-(--bg-elevated)"
            style={{ aspectRatio: resolveCssAspectRatio(aspectRatio) }}
          >
            <div className="absolute inset-0 animate-pulse bg-linear-to-br from-(--bg-elevated) via-(--bg-surface) to-(--bg-elevated)" />
            {idx === 0 ? (
              <div className="relative z-10 flex h-full w-full items-center justify-center gap-2 text-xs text-(--text-muted)">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>{label}</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

interface FailedCardProps {
  error: string;
  retryLabel: string;
  disabled: boolean;
  onRetry: () => void;
  /**
   * In-place retry only works for image generation (it rebuilds the request
   * from the history snapshot). Video is fire-and-forget and its snapshot
   * can't reconstruct the original reference upload, so we hide the retry
   * button for video failures rather than show one that does nothing — the
   * user re-submits from the composer instead.
   */
  canRetry: boolean;
  /**
   * `destructive` = the request actually failed. `muted` = interrupted-by-
   * navigation: nothing went wrong, so it shouldn't shout in red.
   */
  tone?: "destructive" | "muted";
}

function FailedCard({ error, retryLabel, disabled, onRetry, canRetry, tone = "destructive" }: FailedCardProps) {
  const muted = tone === "muted";
  return (
    <Alert
      variant={muted ? "default" : "destructive"}
      className={cn(
        "flex flex-col gap-3 rounded-lg sm:flex-row sm:items-center sm:justify-between",
        muted
          ? "border-transparent bg-(--bg-elevated)/60"
          : "border-transparent bg-destructive/5",
      )}
    >
      <AlertDescription
        className={cn(
          "flex items-start gap-2 text-xs",
          muted ? "text-(--text-secondary)" : "text-destructive",
        )}
      >
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="leading-snug">{error}</span>
      </AlertDescription>
      {canRetry ? (
        <Button
          type="button"
          onClick={onRetry}
          disabled={disabled}
          variant="outline"
          size="xs"
          className={cn(
            "self-start bg-(--bg-surface) sm:self-auto",
            muted
              ? "border-(--border-subtle) text-(--text-secondary) hover:bg-(--bg-elevated)"
              : "border-destructive/40 text-destructive hover:bg-destructive/10",
          )}
        >
          <RefreshCw className="h-3 w-3" />
          {retryLabel}
        </Button>
      ) : null}
    </Alert>
  );
}

interface AssetTileProps {
  assets: AssetDTO[];
  prompt: string;
  aspectRatio: string;
  labels: {
    regenerate: string;
    sendToCanvas: string;
    download: string;
    select: string;
    resultAlt: (position: number, prompt: string) => string;
    actionForResult: (action: string, position: number) => string;
    canvasShort: string;
  };
  disabled: boolean;
  onRegenerate: () => void;
  onSendToCanvas: (asset: AssetDTO) => void;
  selectedAssetIds: string[];
  onToggleSelect: (id: string) => void;
}

function AssetTile({
  assets,
  prompt,
  aspectRatio,
  labels,
  disabled,
  onRegenerate,
  onSendToCanvas,
  selectedAssetIds,
  onToggleSelect,
}: AssetTileProps) {
  const reduce = useReducedMotion();
  const cols = assets.length === 1 ? "grid-cols-1" : assets.length === 2 ? "grid-cols-2" : assets.length === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-4";
  return (
    <div className={cn("grid gap-2", cols)}>
      {assets.map((asset, index) => {
        const isVideo = asset.modality === "VIDEO" || asset.mimeType.startsWith("video/");
        const isSelected = selectedAssetIds.includes(asset.id);
        const position = index + 1;
        return (
          <div
            key={asset.id}
            className={cn(
              "group/tile relative overflow-hidden rounded-lg border bg-(--bg-elevated)",
              isSelected
                ? "border-(--accent-glow) ring-2 ring-(--accent-glow)/40"
                : "border-(--border-subtle)",
            )}
            style={{
              aspectRatio: resolveCssAspectRatio(aspectRatio, asset.width, asset.height),
            }}
          >
            {/* Top-left select checkbox — only on images, only after one has
                been picked OR on hover, to avoid visual noise. */}
            {!isVideo ? (
              <Button
                type="button"
                aria-label={labels.actionForResult(labels.select, position)}
                aria-pressed={isSelected}
                onClick={() => onToggleSelect(asset.id)}
                variant="ghost"
                size="icon-xs"
                className={cn(
                  "absolute left-2 top-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md border transition-[color,background-color,border-color,opacity]",
                  isSelected
                    ? "border-(--accent-glow) bg-(--accent-glow) text-(--bg-base) opacity-100"
                    : "border-white/70 bg-black/40 text-white opacity-100 md:opacity-0 md:group-hover/tile:opacity-100 md:group-focus-within/tile:opacity-100",
                )}
              >
                {isSelected ? <Check className="h-3.5 w-3.5" /> : null}
              </Button>
            ) : null}
            {isVideo ? (
              <video
                src={asset.url}
                className="h-full w-full object-contain"
                aria-label={labels.resultAlt(position, prompt)}
                controls
                muted
                loop
                playsInline
                autoPlay={!reduce}
              />
            ) : (
              <AssetImage
                src={asset.url}
                alt={labels.resultAlt(position, prompt)}
                className="h-full w-full object-contain transition-transform duration-(--motion-control) md:group-hover/tile:scale-[1.02]"
              />
            )}

            {/* Hover overlay with the three required actions. */}
            <div
              className={cn(
                "absolute inset-0 flex gap-1.5 bg-linear-to-t from-black/55 via-black/0 to-transparent p-2 opacity-100 transition-opacity duration-(--motion-control)",
                isVideo ? "items-start justify-end" : "items-end justify-center",
                "md:pointer-events-none md:opacity-0 md:group-hover/tile:pointer-events-auto md:group-hover/tile:opacity-100 md:group-focus-within/tile:pointer-events-auto md:group-focus-within/tile:opacity-100",
              )}
            >
              {/* Regenerate rebuilds an image request from history; video has
                  no reproducible snapshot, so the action is image-only. */}
              {!isVideo ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      disabled={disabled}
                      onClick={onRegenerate}
                      aria-label={labels.actionForResult(labels.regenerate, position)}
                      variant="ghost"
                      size="icon-xs"
                      className="h-8 w-8 rounded-md bg-white/95 text-foreground shadow-md hover:bg-white"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{labels.regenerate}</TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    onClick={() => downloadAsset(asset)}
                    aria-label={labels.actionForResult(labels.download, position)}
                    variant="ghost"
                    size="icon-xs"
                    className="h-8 w-8 rounded-md bg-white/95 text-foreground shadow-md hover:bg-white"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{labels.download}</TooltipContent>
              </Tooltip>
              {!isVideo ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      disabled={disabled}
                      onClick={() => onSendToCanvas(asset)}
                      aria-label={labels.actionForResult(labels.sendToCanvas, position)}
                      variant="mutedOutline"
                      size="xs"
                      className="h-8 rounded-md px-2 text-xs shadow-md"
                    >
                      <ArrowRight className="h-3 w-3" />
                      <span className="sm:hidden">{labels.canvasShort}</span>
                      <span className="hidden sm:inline">{labels.sendToCanvas}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{labels.sendToCanvas}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
