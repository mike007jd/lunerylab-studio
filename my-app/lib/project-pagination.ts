export const PROJECTS_PAGE_SIZE = 24;
export const PROJECT_JOBS_PAGE_SIZE = 6;
export const PROJECT_CANVAS_SESSIONS_PAGE_SIZE = 12;

export interface CursorPage<TItem> {
  items: TItem[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface KeyedCursorPage<TItem> extends CursorPage<TItem> {
  key: string;
}

export interface ProjectActivityJob {
  id: string;
  status: string;
  prompt: string;
  requestedCount: number;
  successCount: number;
  createdAt: string;
}

export interface ProjectActivitySession {
  id: string;
  title: string;
  status: string;
  zoom: number;
  panX: number;
  panY: number;
  layerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectActivityResponse {
  project: {
    id: string;
    name: string;
    category: "STUDIO";
    createdAt: string;
    updatedAt: string;
  };
  jobs: CursorPage<ProjectActivityJob> | null;
  canvasSessions: CursorPage<ProjectActivitySession> | null;
}

export function normalizeCursorPageSize(
  requested: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return Number.isFinite(requested)
    ? Math.max(1, Math.min(maximum, Math.floor(requested as number)))
    : fallback;
}

export function createCursorPage<TItem extends { id: string }>(
  rows: readonly TItem[],
  limit: number,
): CursorPage<TItem> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  return {
    items,
    hasMore,
    nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
  };
}

export function mergeKeyedCursorPage<TItem extends { id: string }>(
  current: KeyedCursorPage<TItem>,
  requestKey: string,
  page: CursorPage<TItem>,
): KeyedCursorPage<TItem> {
  if (current.key !== requestKey) return current;

  const seen = new Set(current.items.map((item) => item.id));
  return {
    key: current.key,
    items: [...current.items, ...page.items.filter((item) => !seen.has(item.id))],
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

/**
 * Remove a deleted project from a keyed cursor page. When the deleted id is the
 * current Load More cursor, retarget to the new page tail so subsequent pages
 * remain reachable.
 */
export function removeItemFromKeyedCursorPage<TItem extends { id: string }>(
  current: KeyedCursorPage<TItem>,
  deletedId: string,
): KeyedCursorPage<TItem> {
  const items = current.items.filter((item) => item.id !== deletedId);
  if (items.length === current.items.length) return current;

  const cursorWasDeleted = current.nextCursor === deletedId;
  if (!cursorWasDeleted) {
    return {
      ...current,
      items,
    };
  }

  const nextCursor = items[items.length - 1]?.id ?? null;
  const hasMore = Boolean(current.hasMore && nextCursor);
  return {
    ...current,
    items,
    hasMore,
    nextCursor: hasMore ? nextCursor : null,
  };
}

/**
 * After sidebar deletions, keep the recent list filled up to `limit` while
 * tombstoning every deleted id across overlapping refill responses.
 */
export function refillRecentProjects<TItem extends { id: string }>(
  current: readonly TItem[],
  excludedIds: ReadonlySet<string>,
  candidates: readonly TItem[],
  limit: number,
): TItem[] {
  const remaining = current.filter((item) => !excludedIds.has(item.id));
  if (remaining.length >= limit) return remaining.slice(0, limit);

  const seen = new Set(remaining.map((item) => item.id));
  const next = [...remaining];
  for (const candidate of candidates) {
    if (excludedIds.has(candidate.id) || seen.has(candidate.id)) continue;
    next.push(candidate);
    seen.add(candidate.id);
    if (next.length >= limit) break;
  }
  return next.slice(0, limit);
}

export function buildProjectActivitySearchParams(
  section: "jobs" | "canvasSessions",
  cursor: string,
): URLSearchParams {
  return new URLSearchParams({
    section,
    [section === "jobs" ? "jobsCursor" : "canvasSessionsCursor"]: cursor,
  });
}
