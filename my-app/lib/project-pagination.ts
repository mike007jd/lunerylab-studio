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

export function buildProjectActivitySearchParams(
  section: "jobs" | "canvasSessions",
  cursor: string,
): URLSearchParams {
  return new URLSearchParams({
    section,
    [section === "jobs" ? "jobsCursor" : "canvasSessionsCursor"]: cursor,
  });
}
