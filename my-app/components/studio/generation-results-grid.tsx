"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  AssetCompareDialog,
  type PresentedAsset,
} from "@/components/studio/asset-compare-dialog";
import {
  GenerationEntryCard,
  type GenerationEntryLabels,
} from "@/components/studio/generation-entry-card";
import type { GenerationEntry } from "@/components/studio/use-studio-generation-history";
import type { AssetDTO } from "@/lib/types/api";
import type { SdProgress } from "@/lib/types/sd-progress";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

interface GenerationResultsGridProps {
  entries: GenerationEntry[];
  onRegenerate: (entryId: string) => void;
  onSendToCanvas: (entryId: string, asset: AssetDTO) => void;
  onDismiss: (entryId: string) => void;
  onCancel?: (entryId: string) => void;
  onReuseParameters?: (entryId: string) => void;
  progressByEntry?: Record<string, SdProgress | undefined>;
  isEntryBusy?: (entryId: string) => boolean;
  className?: string;
}

export const RECENT_RESULTS_LIMIT = 12;
const NEVER_BUSY = () => false;

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

export const GenerationResultsGrid = memo(function GenerationResultsGrid({
  entries,
  onRegenerate,
  onSendToCanvas,
  onDismiss,
  onCancel,
  onReuseParameters,
  progressByEntry = {},
  isEntryBusy = NEVER_BUSY,
  className,
}: GenerationResultsGridProps) {
  const { t } = useI18n();
  const [showEarlierResults, setShowEarlierResults] = useState(false);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const { visibleEntries, earlierCount } = useMemo(
    () => partitionGenerationResults(entries, showEarlierResults),
    [entries, showEarlierResults],
  );
  const allAssetsById = useMemo(() => {
    const assets = new Map<string, PresentedAsset>();
    for (const entry of entries) {
      entry.assets.forEach((asset, index) => {
        assets.set(asset.id, { asset, prompt: entry.prompt, position: index + 1 });
      });
    }
    return assets;
  }, [entries]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- remove selections for assets no longer present
    setSelectedAssetIds((current) => {
      const retained = current.filter((id) => allAssetsById.has(id));
      return retained.length === current.length ? current : retained;
    });
  }, [allAssetsById]);

  const toggleAssetSelect = useCallback((id: string) => {
    setSelectedAssetIds((current) => {
      if (current.includes(id)) return current.filter((assetId) => assetId !== id);
      return current.length >= 4 ? current : [...current, id];
    });
  }, []);

  const labels = useMemo<GenerationEntryLabels & {
    heading: string;
    earlierResults: string;
    earlierResultsSummary: (count: number) => string;
    showEarlierResults: string;
    showRecentResults: string;
    openLibrary: string;
    compareN: (count: number) => string;
    clear: string;
    compareTitle: string;
  }>(() => ({
    heading: t("studio.results.heading"),
    regenerate: t("studio.results.regenerate"),
    reuseSeed: t("studio.results.reuseSeed"),
    sendToCanvas: t("studio.results.sendToCanvas"),
    download: t("common.download"),
    dismiss: t("studio.results.dismiss"),
    running: t("studio.results.running"),
    videoRunning: t("studio.results.videoRunning"),
    canceled: t("studio.results.canceled"),
    cancel: t("common.cancel"),
    preparingElapsed: (seconds) => t("studio.results.preparingElapsed", { seconds }),
    samplingProgress: (current, total, step, steps, percent) =>
      t("studio.results.samplingProgress", { current, total, step, steps, percent }),
    remainingSeconds: (seconds) => t("studio.results.remainingSeconds", { seconds }),
    remainingMinutes: (minutes) => t("studio.results.remainingMinutes", { minutes }),
    finalizing: t("studio.results.finalizing"),
    failed: t("studio.results.failed"),
    interrupted: t("studio.results.interrupted"),
    retry: t("studio.results.retry"),
    refsCount: (count) =>
      t(count === 1 ? "studio.results.referenceSingle" : "studio.results.referenceMultiple", {
        count,
      }),
    select: t("studio.results.select"),
    partial: (actual, expected) => t("studio.results.partial", { actual, expected }),
    resultAlt: (position, prompt) => t("studio.results.resultAlt", { position, prompt }),
    actionForResult: (action, position) =>
      t("studio.results.actionForResult", { action, position }),
    canvasShort: t("studio.results.canvasShort"),
    earlierResults: t("studio.earlierResults"),
    earlierResultsSummary: (count) => t("studio.earlierResultsSummary", { count }),
    showEarlierResults: t("studio.showEarlierResults"),
    showRecentResults: t("studio.showRecentResults"),
    openLibrary: t("studio.openLibrary"),
    compareN: (count) => t("studio.results.compare", { count }),
    clear: t("studio.results.clear"),
    compareTitle: t("studio.results.compareTitle"),
  }), [t]);

  if (entries.length === 0) return null;

  const comparedAssets = selectedAssetIds
    .map((id) => allAssetsById.get(id))
    .filter((asset): asset is PresentedAsset => Boolean(asset));

  return (
    <section
      data-testid="studio-results-grid"
      aria-label={labels.heading}
      className={cn("mx-auto w-full max-w-5xl space-y-3", className)}
    >
      <div className="flex items-center gap-3 px-1">
        <h2 className="text-xs font-semibold text-(--text-muted)">{labels.heading}</h2>
        <span className="h-px flex-1 bg-linear-to-r from-transparent via-(--border-subtle) to-transparent" />
      </div>
      <div id="studio-generation-results" className="space-y-5">
        <AnimatePresence initial={false}>
          {visibleEntries.map((entry) => (
            <GenerationEntryCard
              key={entry.id}
              entry={entry}
              progress={progressByEntry[entry.id]}
              labels={labels}
              busy={isEntryBusy(entry.id)}
              selectedAssetIds={selectedAssetIds}
              onToggleSelect={toggleAssetSelect}
              onRegenerate={() => onRegenerate(entry.id)}
              onSendToCanvas={(asset) => onSendToCanvas(entry.id, asset)}
              onDismiss={() => onDismiss(entry.id)}
              onCancel={
                onCancel && entry.mode === "image" && entry.status === "running"
                  ? () => onCancel(entry.id)
                  : undefined
              }
              onReuseParameters={
                onReuseParameters ? () => onReuseParameters(entry.id) : undefined
              }
            />
          ))}
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
              onClick={() => setSelectedAssetIds([])}
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

      <AssetCompareDialog
        open={compareOpen}
        onOpenChange={setCompareOpen}
        assets={comparedAssets}
        title={labels.compareTitle}
        getAlt={labels.resultAlt}
      />
    </section>
  );
});
