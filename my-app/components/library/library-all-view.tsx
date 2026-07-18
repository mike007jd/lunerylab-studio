"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { PageReveal } from "@/components/motion/motion-primitives";
import { LibraryAssetTabs, type LibraryAsset } from "@/components/library/library-asset-tabs";
import { useLibraryAssetActions } from "@/components/library/use-library-asset-actions";
import { fetchJson, toErrorMessage } from "@/lib/client/fetch-json";
import { useT } from "@/lib/i18n/useT";
import type { LibrarySearchCounts } from "@/lib/library-search";

interface LibraryAllViewProps {
  initialPage: LibrarySearchResponse;
}

interface LibrarySearchResponse {
  assets: LibraryAsset[];
  hasMore: boolean;
  nextCursor: string | null;
  counts: LibrarySearchCounts;
}

const ASSET_PAGE_SIZE = 200;

/** Library = the cross-project + unassigned all-assets surface. The per-project
 * view lives at /projects/[id]; here every asset the workspace owns is browsable
 * in one flat gallery, and the sidebar is the project switcher. */
export function LibraryAllView({ initialPage }: LibraryAllViewProps) {
  const t = useT();
  const searchParams = useSearchParams();
  const highlightedAssetId = searchParams.get("asset")?.trim() || null;

  const [assets, setAssets] = useState<LibraryAsset[]>(initialPage.assets);
  const [assetCounts, setAssetCounts] = useState(initialPage.counts);
  const [assetError, setAssetError] = useState("");
  const [hasMore, setHasMore] = useState(initialPage.hasMore);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [assetRefreshKey, setAssetRefreshKey] = useState(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const {
    notice,
    error,
    pendingDeleteAssetId,
    setPendingDeleteAssetId,
    deletingAsset,
    handleUseAsReference,
    handleOpenInCanvas,
    handleConfirmDeleteAsset,
    handleRestoreAsset,
    pendingPermanentDeleteAssetId,
    setPendingPermanentDeleteAssetId,
    permanentlyDeletingAsset,
    openingCanvasAssetId,
    canvasActionError,
    handleConfirmPermanentDeleteAsset,
  } = useLibraryAssetActions({
    onAssetDeleted: (id) => {
      setAssets((prev) => prev.filter((asset) => asset.id !== id));
      setAssetRefreshKey((key) => key + 1);
    },
    onAssetRestored: (asset) => {
      setAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)]);
      setAssetRefreshKey((key) => key + 1);
    },
  });

  const loadMoreAssets = useCallback(async () => {
    if (!hasMore || !nextCursor || loadControllerRef.current) return;
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setIsLoadingMore(true);
    try {
      const params = new URLSearchParams({
        limit: String(ASSET_PAGE_SIZE),
        cursor: nextCursor,
      });
      const page = await fetchJson<LibrarySearchResponse>(
        `/api/library/search?${params.toString()}`,
        { cache: "no-store", signal: controller.signal },
      );
      setAssets((current) => {
        const seen = new Set(current.map((asset) => asset.id));
        return [...current, ...page.assets.filter((asset) => !seen.has(asset.id))];
      });
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor);
      setAssetCounts(page.counts);
      setAssetError("");
    } catch (requestError) {
      if (!controller.signal.aborted) {
        setAssetError(toErrorMessage(requestError, t("library.loadDetailFailed")));
      }
    } finally {
      if (loadControllerRef.current === controller) loadControllerRef.current = null;
      if (!controller.signal.aborted) setIsLoadingMore(false);
    }
  }, [hasMore, nextCursor, t]);

  useEffect(() => () => loadControllerRef.current?.abort(), []);

  return (
    <PageReveal>
      <section className="min-w-0 w-full space-y-6">
        {notice ? (
          <Alert className="border-primary/30 bg-primary/10 text-primary">
            <AlertDescription className="justify-center text-xs font-medium text-primary">
              {notice}
            </AlertDescription>
          </Alert>
        ) : null}
        <LibraryAssetTabs
          assets={assets}
          counts={assetCounts}
          onCountsChange={setAssetCounts}
          refreshKey={assetRefreshKey}
          showProjectContext
          hasRemoteMore={hasMore && Boolean(nextCursor)}
          isLoadingMore={isLoadingMore}
          onLoadMore={() => void loadMoreAssets()}
          highlightedAssetId={highlightedAssetId}
          onUseAsReference={handleUseAsReference}
          onOpenInCanvas={(id) => void handleOpenInCanvas(id)}
          openingCanvasAssetId={openingCanvasAssetId}
          canvasActionError={canvasActionError}
          onDelete={(id) => setPendingDeleteAssetId(id)}
          onRestore={(id) => void handleRestoreAsset(id)}
          onPermanentDelete={(id) => setPendingPermanentDeleteAssetId(id)}
        />
        {assetError ? <p className="text-sm text-destructive">{assetError}</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <ConfirmActionDialog
          open={Boolean(pendingDeleteAssetId)}
          onOpenChange={(open) => {
            if (!open && !deletingAsset) setPendingDeleteAssetId(null);
          }}
          title={t("library.deleteAsset")}
          description={t("library.deleteAssetConfirm")}
          cancelLabel={t("common.cancel")}
          confirmLabel={deletingAsset ? t("library.deleting") : t("common.delete")}
          pending={deletingAsset}
          tone="destructive"
          onConfirm={handleConfirmDeleteAsset}
        />
        <ConfirmActionDialog
          open={Boolean(pendingPermanentDeleteAssetId)}
          onOpenChange={(open) => {
            if (!open && !permanentlyDeletingAsset) setPendingPermanentDeleteAssetId(null);
          }}
          title={t("library.permanentDeleteAsset")}
          description={t("library.permanentDeleteAssetConfirm")}
          cancelLabel={t("common.cancel")}
          confirmLabel={permanentlyDeletingAsset ? t("library.permanentlyDeleting") : t("library.permanentDeleteAsset")}
          pending={permanentlyDeletingAsset}
          tone="destructive"
          onConfirm={handleConfirmPermanentDeleteAsset}
        />
      </section>
    </PageReveal>
  );
}
