import type { LibrarySearchCounts } from "@/lib/library-search";
import type { ContentOrigin } from "@/lib/types/api";

export type LibraryTabKey = "all" | "generated" | "reference" | "template" | "output" | "trash";
export const LIBRARY_TAB_KEYS: readonly LibraryTabKey[] = [
  "all",
  "generated",
  "reference",
  "template",
  "output",
  "trash",
];

interface LibraryTabAsset {
  kind: string;
  origin: ContentOrigin;
  mimeType: string;
  deletedAt?: string | null;
}

export function matchesLibraryTab(asset: LibraryTabAsset, tab: LibraryTabKey): boolean {
  switch (tab) {
    case "all":
      return !asset.deletedAt;
    case "generated":
      return asset.origin === "USER" && asset.kind === "GENERATED";
    case "reference":
      return asset.origin === "USER" && asset.kind === "REFERENCE";
    case "template":
      return asset.origin === "TEMPLATE" && !asset.deletedAt;
    case "output":
      return asset.origin === "USER" && asset.mimeType.startsWith("video/");
    case "trash":
      return Boolean(asset.deletedAt);
  }
}

export function getVisibleLibraryTabs(counts: LibrarySearchCounts): readonly LibraryTabKey[] {
  return [
    "all",
    "generated",
    "reference",
    ...(counts.template > 0 ? (["template"] as const) : []),
    ...(counts.output > 0 ? (["output"] as const) : []),
    "trash",
  ];
}

interface BuildLibrarySearchParamsOptions {
  query: string;
  tab: LibraryTabKey;
  projectId?: string;
  cursor?: string;
  limit?: number;
  countsOnly?: boolean;
}

export interface LibraryServerSearchPage<TAsset> {
  assets: TAsset[];
  nextCursor: string | null;
  hasMore: boolean;
  counts: LibrarySearchCounts;
}

export interface KeyedLibraryServerSearchPage<TAsset>
  extends LibraryServerSearchPage<TAsset> {
  key: string;
}

export function shouldUseServerLibraryQuery(query: string, tab: LibraryTabKey): boolean {
  return query.trim().length > 0 || tab !== "all";
}

export function buildLibrarySearchParams({
  query,
  tab,
  projectId,
  cursor,
  limit = 200,
  countsOnly = false,
}: BuildLibrarySearchParamsOptions): URLSearchParams {
  const params = new URLSearchParams({ limit: String(limit) });
  const normalizedQuery = query.trim();
  if (normalizedQuery) params.set("q", normalizedQuery);
  if (projectId) params.set("projectId", projectId);
  if (cursor) params.set("cursor", cursor);
  if (countsOnly) params.set("countsOnly", "1");

  if (tab === "generated") {
    params.set("kind", "GENERATED");
    params.set("origin", "USER");
  }
  if (tab === "reference") {
    params.set("kind", "REFERENCE");
    params.set("origin", "USER");
  }
  if (tab === "template") params.set("origin", "TEMPLATE");
  if (tab === "output") {
    params.set("modality", "VIDEO");
    params.set("origin", "USER");
  }
  if (tab === "trash") params.set("trash", "1");

  return params;
}

export function mergeLibraryServerSearchPage<TAsset extends { id: string }>(
  current: KeyedLibraryServerSearchPage<TAsset> | null,
  requestKey: string,
  page: LibraryServerSearchPage<TAsset>,
): KeyedLibraryServerSearchPage<TAsset> | null {
  if (!current || current.key !== requestKey) return current;

  const seen = new Set(current.assets.map((asset) => asset.id));
  return {
    key: current.key,
    assets: [...current.assets, ...page.assets.filter((asset) => !seen.has(asset.id))],
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    counts: page.counts,
  };
}
