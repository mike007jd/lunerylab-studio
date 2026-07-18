"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AssetCard } from "@/components/board/asset-card";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ImageIcon, Layers, Loader2, Search, Sparkles, Trash2 } from "@/components/ui/icons";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { fetchJson, toErrorMessage } from "@/lib/client/fetch-json";
import {
  buildLibrarySearchParams,
  getVisibleLibraryTabs,
  LIBRARY_TAB_KEYS,
  matchesLibraryTab,
  mergeLibraryServerSearchPage,
  shouldUseServerLibraryQuery,
  type KeyedLibraryServerSearchPage,
  type LibraryServerSearchPage,
  type LibraryTabKey,
} from "@/lib/client/library-server-query";
import { useT } from "@/lib/i18n/useT";
import type { LibrarySearchCounts } from "@/lib/library-search";
import type { ContentOrigin } from "@/lib/types/api";

const PAGE_SIZE = 24;
const SKELETON_COUNT = 8;

export interface LibraryAsset {
  id: string;
  kind: string;
  origin: ContentOrigin;
  url: string;
  mimeType: string;
  createdAt: string;
  /** Optional prompt of the originating job, for search. Not all assets carry one. */
  prompt?: string | null;
  provider?: string | null;
  model?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  agentTaskId?: string | null;
  agentTaskSummary?: string | null;
  parentAssetId?: string | null;
  summary?: string | null;
  deletedAt?: string | null;
  generationSeed?: number | null;
  generationSteps?: number | null;
  generationCfg?: number | null;
  negativePrompt?: string | null;
  generationModel?: string | null;
}

interface LibraryAssetTabsProps {
  assets: LibraryAsset[];
  /** Whole-scope counts supplied by the server-hydrated parent page. */
  counts: LibrarySearchCounts;
  /** Keeps parent counts current after mutations initiated inside the tabs. */
  onCountsChange?: (counts: LibrarySearchCounts) => void;
  /** Scope server-backed search and tab filters to one project when present. */
  projectId?: string;
  /** Bump after a mutation so active server results/counts revalidate. */
  refreshKey?: number;
  /** Global Library needs project context; a project workspace already supplies it. */
  showProjectContext?: boolean;
  highlightedAssetId?: string | null;
  /** True while the parent's initial server page is still being augmented. */
  isStreaming?: boolean;
  /** True when the parent owns another server cursor page. */
  hasRemoteMore?: boolean;
  /** True while the parent is fetching one server cursor page. */
  isLoadingMore?: boolean;
  /** Explicitly fetch one more server cursor page after local results are exhausted. */
  onLoadMore?: () => void;
  onUseAsReference: (assetId: string) => void;
  onOpenInCanvas?: (assetId: string) => void;
  openingCanvasAssetId?: string | null;
  canvasActionError?: { assetId: string; message: string } | null;
  onGenerateVideo?: (assetId: string) => void;
  onDelete?: (assetId: string) => void;
  onRestore?: (assetId: string) => void;
  onPermanentDelete?: (assetId: string) => void;
  className?: string;
}

type LibraryServerSearchResponse = LibraryServerSearchPage<LibraryAsset>;

function tabForHighlightedAsset(
  asset: LibraryAsset,
  visibleTabs: readonly LibraryTabKey[],
): LibraryTabKey {
  if (asset.deletedAt && visibleTabs.includes("trash")) return "trash";
  if (matchesLibraryTab(asset, "output") && visibleTabs.includes("output")) {
    return "output";
  }
  if (asset.origin === "TEMPLATE" && visibleTabs.includes("template")) {
    return "template";
  }
  if (asset.kind === "REFERENCE") {
    return "reference";
  }
  if (asset.kind === "GENERATED") {
    return "generated";
  }
  return "all";
}

/**
 * Asset browser with server-backed search/filtering and local
 * incremental rendering. The unfiltered All view reuses server-hydrated data;
 * every search or category filter queries the complete library scope.
 */
export function LibraryAssetTabs({
  assets,
  counts,
  onCountsChange,
  projectId,
  refreshKey = 0,
  showProjectContext = true,
  highlightedAssetId,
  isStreaming = false,
  hasRemoteMore = false,
  isLoadingMore = false,
  onLoadMore,
  onUseAsReference,
  onOpenInCanvas,
  openingCanvasAssetId,
  canvasActionError,
  onGenerateVideo,
  onDelete,
  onRestore,
  onPermanentDelete,
  className,
}: LibraryAssetTabsProps) {
  const t = useT();
  const [tab, setTab] = useState<LibraryTabKey>("all");
  const [search, setSearch] = useState("");
  // Input stays instant; the expensive filter/visible-count work runs off the
  // debounced copy so each keystroke doesn't re-derive the whole grid.
  const debouncedSearch = useDebouncedValue(search, 180);
  const [manualTabForHighlightedId, setManualTabForHighlightedId] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLButtonElement | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const loadMoreRequestTokenRef = useRef(0);
  const [serverPage, setServerPage] = useState<KeyedLibraryServerSearchPage<LibraryAsset> | null>(null);
  const [serverLoadingMoreRequest, setServerLoadingMoreRequest] = useState<{
    key: string;
    token: number;
  } | null>(null);
  const [serverQueryError, setServerQueryError] = useState<{ key: string; message: string } | null>(null);
  const [serverRetryToken, setServerRetryToken] = useState(0);

  const baseAssetsByKind = useMemo(() => {
    return LIBRARY_TAB_KEYS.reduce<Record<LibraryTabKey, LibraryAsset[]>>((acc, key) => {
      acc[key] = assets
        .filter((asset) => matchesLibraryTab(asset, key))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return acc;
    }, { all: [], generated: [], reference: [], template: [], output: [], trash: [] });
  }, [assets]);

  const visibleTabs = useMemo<readonly LibraryTabKey[]>(
    () => getVisibleLibraryTabs(counts),
    [counts],
  );

  const highlightedAsset = useMemo(
    () => (highlightedAssetId ? baseAssetsByKind.all.find((asset) => asset.id === highlightedAssetId) ?? null : null),
    [baseAssetsByKind.all, highlightedAssetId],
  );

  const fallbackTab: LibraryTabKey =
    tab === "output" && !visibleTabs.includes("output") ? "all" : tab;
  const highlightedTargetTab = highlightedAsset
    ? tabForHighlightedAsset(highlightedAsset, visibleTabs)
    : null;
  const fallbackTabContainsHighlight = highlightedAsset
    ? baseAssetsByKind[fallbackTab].some((asset) => asset.id === highlightedAsset.id)
    : true;
  const shouldNavigateToHighlight =
    Boolean(highlightedAsset && highlightedAssetId && manualTabForHighlightedId !== highlightedAssetId);
  const activeTab: LibraryTabKey =
    shouldNavigateToHighlight && highlightedTargetTab && !fallbackTabContainsHighlight
      ? highlightedTargetTab
      : fallbackTab;

  const serverQueryActive = shouldUseServerLibraryQuery(debouncedSearch, activeTab);
  const serverQueryKey = [
    projectId ?? "all-projects",
    activeTab,
    debouncedSearch.trim(),
    refreshKey,
    serverRetryToken,
  ].join("::");

  useEffect(() => {
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    if (!serverQueryActive) return;

    const controller = new AbortController();
    const params = buildLibrarySearchParams({
      query: debouncedSearch,
      tab: activeTab,
      projectId,
    });

    void fetchJson<LibraryServerSearchResponse>(
      `/api/library/search?${params.toString()}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        setServerQueryError(null);
        setServerPage({ key: serverQueryKey, ...page });
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setServerQueryError({
            key: serverQueryKey,
            message: toErrorMessage(requestError, t("library.searchFailed")),
          });
        }
      });

    return () => {
      controller.abort();
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
    };
  }, [
    activeTab,
    debouncedSearch,
    projectId,
    serverQueryActive,
    serverQueryKey,
    t,
  ]);

  useEffect(() => {
    if (refreshKey <= 0 || !onCountsChange) return;

    const controller = new AbortController();
    const params = buildLibrarySearchParams({
      query: "",
      tab: "all",
      projectId,
      countsOnly: true,
    });
    void fetchJson<LibraryServerSearchResponse>(
      `/api/library/search?${params.toString()}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then((page) => {
        if (!controller.signal.aborted) onCountsChange(page.counts);
      })
      .catch(() => {
        // Keep the last confirmed count; a later parent page or mutation refresh
        // will reconcile it without undoing the successful asset action.
      });

    return () => controller.abort();
  }, [onCountsChange, projectId, refreshKey]);

  const serverPageReady = serverPage?.key === serverQueryKey;
  const displayCounts = serverQueryActive && serverPageReady ? serverPage.counts : counts;
  const serverLoadingMore = serverLoadingMoreRequest?.key === serverQueryKey;
  const activeServerError = serverQueryError?.key === serverQueryKey
    ? serverQueryError.message
    : "";
  const activeSourceAssets = useMemo(
    () => (serverQueryActive ? (serverPageReady ? serverPage.assets : []) : assets),
    [assets, serverPage, serverPageReady, serverQueryActive],
  );
  const filtered = useMemo(() => {
    const results = activeSourceAssets
      .filter((asset) => matchesLibraryTab(asset, activeTab))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (
      serverQueryActive ||
      !shouldNavigateToHighlight ||
      !highlightedAsset ||
      results.some((asset) => asset.id === highlightedAsset.id)
    ) {
      return results;
    }
    return [highlightedAsset, ...results];
  }, [activeSourceAssets, activeTab, highlightedAsset, serverQueryActive, shouldNavigateToHighlight]);

  // Reset key bumps when (tab,search) changes; visibleCount lives keyed to it.
  const filterKey = `${activeTab}::${debouncedSearch}`;
  const [visibleState, setVisibleState] = useState<{ key: string; count: number }>({
    key: filterKey,
    count: PAGE_SIZE,
  });
  const baseVisibleCount = visibleState.key === filterKey ? visibleState.count : PAGE_SIZE;

  const highlightedRequiredCount = useMemo(() => {
    if (!highlightedAssetId) return 0;
    const targetIndex = filtered.findIndex((asset) => asset.id === highlightedAssetId);
    if (targetIndex < 0) return 0;
    return Math.ceil((targetIndex + 1) / PAGE_SIZE) * PAGE_SIZE;
  }, [filtered, highlightedAssetId]);

  const visibleCount = Math.max(baseVisibleCount, highlightedRequiredCount);
  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMore = filtered.length > visible.length;

  // Reveal another page. Shared by the IntersectionObserver (pointer users) and
  // the focusable "Load more" button (keyboard / screen-reader users).
  const loadMore = useCallback(() => {
    setVisibleState((prev) =>
      prev.key === filterKey
        ? { key: filterKey, count: prev.count + PAGE_SIZE }
        : { key: filterKey, count: PAGE_SIZE * 2 },
    );
  }, [filterKey]);

  useEffect(() => {
    if (!highlightedAssetId || !visible.some((asset) => asset.id === highlightedAssetId)) return;
    const escaped = window.CSS?.escape?.(highlightedAssetId) ?? highlightedAssetId.replace(/"/g, '\\"');
    const timer = window.setTimeout(() => {
      document
        .querySelector(`[data-library-asset-id="${escaped}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [highlightedAssetId, visible]);

  useEffect(() => {
    if (!hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMore();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  // Initial-fetch skeleton: nothing loaded yet but the parent is still streaming
  // the first assets in. Distinct from "loading more" (cursor loop after the
  // first paint) and from genuine empties.
  const showInitialSkeleton = serverQueryActive
    ? !serverPageReady && !activeServerError
    : assets.length === 0 && isStreaming;
  const hasSearch = debouncedSearch.trim().length > 0;

  const loadMoreServerResults = useCallback(async () => {
    if (
      !serverQueryActive ||
      !serverPageReady ||
      !serverPage?.hasMore ||
      !serverPage.nextCursor ||
      loadMoreControllerRef.current
    ) {
      return;
    }
    const requestKey = serverQueryKey;
    const controller = new AbortController();
    const requestToken = ++loadMoreRequestTokenRef.current;
    loadMoreControllerRef.current = controller;
    setServerLoadingMoreRequest({ key: requestKey, token: requestToken });
    try {
      const params = buildLibrarySearchParams({
        query: debouncedSearch,
        tab: activeTab,
        projectId,
        cursor: serverPage.nextCursor,
      });
      const page = await fetchJson<LibraryServerSearchResponse>(
        `/api/library/search?${params.toString()}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (controller.signal.aborted || loadMoreControllerRef.current !== controller) return;
      setServerPage((current) => mergeLibraryServerSearchPage(current, requestKey, page));
      setServerQueryError((current) => (current?.key === requestKey ? null : current));
    } catch (requestError) {
      if (controller.signal.aborted || loadMoreControllerRef.current !== controller) return;
      setServerQueryError({
        key: requestKey,
        message: toErrorMessage(requestError, t("library.searchFailed")),
      });
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
      }
      setServerLoadingMoreRequest((current) =>
        current?.token === requestToken ? null : current,
      );
    }
  }, [
    activeTab,
    debouncedSearch,
    projectId,
    serverPage,
    serverPageReady,
    serverQueryActive,
    serverQueryKey,
    t,
  ]);

  const renderRemoteLoadMore = () =>
    (serverQueryActive ? serverPageReady && serverPage?.hasMore : hasRemoteMore) ? (
      <div className="mt-4 flex justify-center">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={serverQueryActive ? () => void loadMoreServerResults() : onLoadMore}
          loading={serverQueryActive ? serverLoadingMore : isLoadingMore}
          disabled={serverQueryActive ? false : !onLoadMore}
          className="rounded-lg px-4 py-2 text-xs font-medium text-(--text-muted) transition-colors hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {t("studio.libraryTabs.loadMore")}
        </Button>
      </div>
    ) : null;

  const renderEmpty = (key: LibraryTabKey) => {
    if (hasSearch) {
      return (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search />
            </EmptyMedia>
            <EmptyTitle>
              {t("studio.libraryTabs.noResultsTitle", { query: debouncedSearch.trim() })}
            </EmptyTitle>
            <EmptyDescription>{t("studio.libraryTabs.noResultsDescription")}</EmptyDescription>
          </EmptyHeader>
          <Button type="button" variant="outline" size="sm" onClick={() => setSearch("")}>
            {t("studio.libraryTabs.clearSearch")}
          </Button>
        </Empty>
      );
    }

    if (key === "reference") {
      return (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Layers />
            </EmptyMedia>
            <EmptyTitle>{t("studio.libraryTabs.emptyReferenceTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("studio.libraryTabs.emptyReferenceDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }

    if (key === "generated") {
      return (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Sparkles />
            </EmptyMedia>
            <EmptyTitle>{t("studio.libraryTabs.emptyGenerated")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      );
    }

    if (key === "trash") {
      return (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Trash2 /></EmptyMedia>
            <EmptyTitle>{t("studio.libraryTabs.emptyTrashTitle")}</EmptyTitle>
            <EmptyDescription>{t("studio.libraryTabs.emptyTrashDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }

    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ImageIcon />
          </EmptyMedia>
          <EmptyTitle>{t("studio.libraryTabs.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("studio.libraryTabs.emptyDescription")}</EmptyDescription>
        </EmptyHeader>
        <Button asChild size="sm">
          <Link href="/studio">{t("studio.libraryTabs.emptyAction")}</Link>
        </Button>
      </Empty>
    );
  };

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => {
        setTab(value as LibraryTabKey);
        setManualTabForHighlightedId(highlightedAssetId ?? null);
      }}
      className={className}
    >
      <div className="flex flex-wrap items-center gap-3">
        <TabsList variant="line">
          {visibleTabs.map((key) => (
            <TabsTrigger key={key} value={key}>
              {t(`studio.libraryTabs.${key}`)}
              {displayCounts[key] > 0 ? (
                <span className="ml-1 rounded-full bg-(--bg-elevated) px-1.5 py-0.5 text-xs text-(--text-muted)">
                  {displayCounts[key]}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="relative ml-auto flex-1 min-w-[180px] max-w-xs">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-(--text-muted)" />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("studio.libraryTabs.searchPlaceholderBroad")}
            className="h-9 pl-7 text-sm"
            aria-label={t("studio.libraryTabs.searchPlaceholderBroad")}
          />
        </div>
      </div>

      {/* Radix Tabs already mounts only the active TabsContent's children when
          forceMount is off, so we render one shared grid for the active tab
          instead of computing a grid per tab. */}
      {visibleTabs.map((key) => (
        <TabsContent key={key} value={key} className="mt-4">
          {key === activeTab ? (
            showInitialSkeleton ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: SKELETON_COUNT }).map((_, index) => (
                  <Skeleton key={index} className="aspect-square w-full rounded-xl" />
                ))}
              </div>
            ) : serverQueryActive && activeServerError && filtered.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search />
                  </EmptyMedia>
                  <EmptyTitle>{activeServerError}</EmptyTitle>
                </EmptyHeader>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setServerRetryToken((token) => token + 1)}
                >
                  {t("library.retry")}
                </Button>
              </Empty>
            ) : filtered.length === 0 ? (
              <>
                {renderEmpty(key)}
                {renderRemoteLoadMore()}
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {visible.map((asset, index) => (
                    <AssetCard
                      key={asset.id}
                      id={asset.id}
                      priority={index === 0}
                      highlighted={asset.id === highlightedAssetId}
                      url={asset.url}
                      kind={asset.kind}
                      origin={asset.origin}
                      mimeType={asset.mimeType}
                      createdAt={asset.createdAt}
                      prompt={asset.prompt}
                      provider={asset.provider}
                      model={asset.model}
                      generationSeed={asset.generationSeed}
                      generationSteps={asset.generationSteps}
                      generationCfg={asset.generationCfg}
                      negativePrompt={asset.negativePrompt}
                      generationModel={asset.generationModel}
                      projectName={showProjectContext ? asset.projectName : null}
                      agentTaskId={asset.agentTaskId}
                      agentTaskSummary={asset.agentTaskSummary}
                      parentAssetId={asset.parentAssetId}
                      summary={asset.summary}
                      deletedAt={asset.deletedAt}
                      onUseAsReference={onUseAsReference}
                      onOpenInCanvas={onOpenInCanvas}
                      openInCanvasPending={openingCanvasAssetId === asset.id}
                      openInCanvasDisabled={Boolean(openingCanvasAssetId)}
                      openInCanvasError={canvasActionError?.assetId === asset.id ? canvasActionError?.message ?? null : null}
                      onGenerateVideo={onGenerateVideo}
                      onDelete={onDelete}
                      onRestore={onRestore}
                      onPermanentDelete={onPermanentDelete}
                    />
                  ))}
                </div>
                {hasMore ? (
                  <div className="mt-4 flex justify-center">
                    <Button
                      ref={sentinelRef}
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={loadMore}
                      className="rounded-lg px-4 py-2 text-xs font-medium text-(--text-muted) transition-colors hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      {t("studio.libraryTabs.loadMore")}
                    </Button>
                  </div>
                ) : (serverQueryActive ? serverPageReady && serverPage?.hasMore : hasRemoteMore) ? (
                  renderRemoteLoadMore()
                ) : !serverQueryActive && isStreaming ? (
                  <div className="mt-4 flex items-center justify-center gap-2 text-xs text-(--text-muted)">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    <span>{t("studio.libraryTabs.loadingMore")}</span>
                  </div>
                ) : null}
                {serverQueryActive && activeServerError ? (
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-sm text-destructive">
                    <span>{activeServerError}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setServerRetryToken((token) => token + 1)}
                    >
                      {t("library.retry")}
                    </Button>
                  </div>
                ) : null}
              </>
            )
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}
