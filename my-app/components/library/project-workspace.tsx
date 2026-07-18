"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  PencilLine,
  Sparkles,
  Trash2,
  X,
} from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { HoverLiftCard } from "@/components/motion/motion-primitives";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { EmptyStateCard } from "@/components/ui/page-primitives";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { LibraryAssetTabs, type LibraryAsset } from "@/components/library/library-asset-tabs";
import { fetchJson, HttpError, toErrorMessage } from "@/lib/client/fetch-json";
import { useLibraryAssetActions } from "@/components/library/use-library-asset-actions";
import { useActiveProject } from "@/lib/client/active-project-provider";
import { useDesktopAvailable } from "@/hooks/use-desktop-available";
import { useT } from "@/lib/i18n/useT";
import { type TFunction } from "@/lib/i18n/provider";
import { TransitionLink } from "@/components/motion/transition-link";
import { ProjectNameDialog } from "@/components/projects/project-name-dialog";
import { announceProjectUpdated } from "@/lib/client/project-created-event";
import { renameProject } from "@/lib/client/projects";
import { addCanvasEntrySource } from "@/lib/client/creation-flow";
import {
  EMPTY_LIBRARY_SEARCH_COUNTS,
  type LibrarySearchCounts,
} from "@/lib/library-search";
import {
  buildProjectActivitySearchParams,
  mergeKeyedCursorPage,
  type ProjectActivityJob,
  type ProjectActivityResponse,
  type ProjectActivitySession,
} from "@/lib/project-pagination";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ASSET_PAGE_SIZE = 200;
/** While any job is non-terminal we re-poll its lightweight status at this cadence. */
const JOB_POLL_MS = 3000;
const TERMINAL_JOB_STATUSES = new Set(["SUCCEEDED", "FAILED", "PARTIAL", "CANCELLED", "CANCELED"]);

function isJobRunning(status: string): boolean {
  return !TERMINAL_JOB_STATUSES.has(status);
}

type ProjectDetailSession = ProjectActivitySession;

interface ProjectDetail {
  key: string;
  canvasSessions: ProjectDetailSession[];
  canvasSessionsHasMore: boolean;
  canvasSessionsNextCursor: string | null;
  jobs: ProjectActivityJob[];
  jobsHasMore: boolean;
  jobsNextCursor: string | null;
}

interface ProjectJobStatusResponse {
  jobs: ProjectDetail["jobs"];
}

interface LibrarySearchResponse {
  assets: Array<LibraryAsset & {
    prompt?: string | null;
    provider?: string | null;
    model?: string | null;
    projectName?: string | null;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
  counts: LibrarySearchCounts;
}

/** Normalizes a search-response asset to the LibraryAsset shape the grid wants.
 *  One place to add fields so the three load paths can't drift. */
function toLibraryAsset(asset: LibrarySearchResponse["assets"][number]): LibraryAsset {
  return {
    id: asset.id,
    kind: asset.kind,
    origin: asset.origin,
    url: asset.url,
    mimeType: asset.mimeType,
    createdAt: asset.createdAt,
    prompt: asset.prompt ?? null,
    provider: asset.provider ?? null,
    model: asset.model ?? null,
    agentTaskId: asset.agentTaskId ?? null,
    agentTaskSummary: asset.agentTaskSummary ?? null,
    parentAssetId: asset.parentAssetId ?? null,
    summary: asset.summary ?? null,
    deletedAt: asset.deletedAt ?? null,
    projectId: asset.projectId ?? null,
    projectName: asset.projectName ?? null,
  };
}

/** Cheap change signature for the poll: only re-render on job state changes. */
function jobsSignature(jobs: ProjectDetail["jobs"]): string {
  return jobs.map((j) => `${j.id}:${j.status}:${j.successCount}/${j.requestedCount}`).join("|");
}

/** The heartbeat may contain more rows than the visible history page. Update
 * only loaded jobs so polling never bypasses explicit cursor pagination. */
function mergeProjectJobs(
  current: ProjectDetail["jobs"],
  recent: ProjectDetail["jobs"],
): ProjectDetail["jobs"] {
  const recentById = new Map(recent.map((job) => [job.id, job]));
  return current.map((job) => recentById.get(job.id) ?? job);
}

function projectDetailFromResponse(
  projectId: string,
  response: ProjectActivityResponse,
): ProjectDetail | null {
  if (!response.jobs || !response.canvasSessions) return null;
  return {
    key: projectId,
    jobs: response.jobs.items,
    jobsHasMore: response.jobs.hasMore,
    jobsNextCursor: response.jobs.nextCursor,
    canvasSessions: response.canvasSessions.items,
    canvasSessionsHasMore: response.canvasSessions.hasMore,
    canvasSessionsNextCursor: response.canvasSessions.nextCursor,
  };
}

function relativeTime(iso: string, t: TFunction): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return t("studio.taskIntents.sessionRelativeJustNow");
  if (min < 60) return t("studio.taskIntents.sessionRelativeMinutes", { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("studio.taskIntents.sessionRelativeHours", { count: hr });
  const day = Math.floor(hr / 24);
  return t("studio.taskIntents.sessionRelativeDays", { count: day });
}

function partitionSessionsByRecency(sessions: ProjectDetailSession[]): {
  recent: ProjectDetailSession[];
  older: ProjectDetailSession[];
} {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const recent: ProjectDetailSession[] = [];
  const older: ProjectDetailSession[] = [];
  for (const session of sessions) {
    if (new Date(session.updatedAt).getTime() >= cutoff) recent.push(session);
    else older.push(session);
  }
  const sortDesc = (a: ProjectDetailSession, b: ProjectDetailSession) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  recent.sort(sortDesc);
  older.sort(sortDesc);
  return { recent, older };
}

interface ProjectWorkspaceProps {
  projectId: string;
  heading: string;
  highlightedAssetId?: string | null;
  onSessionDeleted?: (sessionId: string) => void;
  /** Server-hydrated detail (sessions + jobs) so the client mounts with data. */
  initialDetail?: ProjectDetail | null;
  /** Server-hydrated first asset page; client continues paginating from the cursor. */
  initialAssets?: LibraryAsset[];
  initialAssetCounts?: LibrarySearchCounts;
  initialAssetsHasMore?: boolean;
  initialAssetsCursor?: string | null;
}

export function ProjectWorkspace({
  projectId,
  heading,
  highlightedAssetId = null,
  onSessionDeleted,
  initialDetail = null,
  initialAssets,
  initialAssetCounts = EMPTY_LIBRARY_SEARCH_COUNTS,
  initialAssetsHasMore = false,
  initialAssetsCursor = null,
}: ProjectWorkspaceProps) {
  const t = useT();
  const router = useRouter();
  const { setActiveProject } = useActiveProject();
  const desktopAvailable = useDesktopAvailable();

  // Opening a project makes it the active workspace: Studio generation then
  // lands here, and a return trip to Studio targets this project.
  useEffect(() => {
    setActiveProject(projectId);
  }, [projectId, setActiveProject]);

  const [detail, setDetail] = useState<ProjectDetail | null>(initialDetail);
  const [projectName, setProjectName] = useState(heading);
  const [projectNameDialogOpen, setProjectNameDialogOpen] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState(heading);
  const [projectNameError, setProjectNameError] = useState("");
  const [savingProjectName, setSavingProjectName] = useState(false);
  // Hydrated from the server on first mount: no detail skeleton on initial visit.
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [projectAssets, setProjectAssets] = useState<LibraryAsset[]>(initialAssets ?? []);
  const [assetCounts, setAssetCounts] = useState(initialAssetCounts);
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetLoadingMore, setAssetLoadingMore] = useState(false);
  const [assetRefreshKey, setAssetRefreshKey] = useState(0);
  const [assetsHasMore, setAssetsHasMore] = useState(initialAssetsHasMore);
  const [assetsCursor, setAssetsCursor] = useState(initialAssetsCursor);
  const [assetError, setAssetError] = useState("");
  const [assetReloadToken, setAssetReloadToken] = useState(0);
  const [detailReloadToken, setDetailReloadToken] = useState(0);
  const hydratedProjectRef = useRef(initialDetail ? projectId : null);
  const assetsHydratedRef = useRef(initialAssets ? projectId : null);
  const assetLoadMoreControllerRef = useRef<AbortController | null>(null);
  const jobsLoadMoreControllerRef = useRef<AbortController | null>(null);
  const canvasSessionsLoadMoreControllerRef = useRef<AbortController | null>(null);
  const [jobsLoadingMore, setJobsLoadingMore] = useState(false);
  const [canvasSessionsLoadingMore, setCanvasSessionsLoadingMore] = useState(false);
  const [jobsPageError, setJobsPageError] = useState("");
  const [canvasSessionsPageError, setCanvasSessionsPageError] = useState("");
  const [pendingDeleteSession, setPendingDeleteSession] = useState<ProjectDetailSession | null>(null);
  const [deletingSession, setDeletingSession] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [savingRename, setSavingRename] = useState(false);

  const {
    notice,
    error,
    setError,
    pendingDeleteAssetId,
    setPendingDeleteAssetId,
    deletingAsset,
    handleUseAsReference,
    handleOpenInCanvas,
    openingCanvasAssetId,
    canvasActionError,
    handleConfirmDeleteAsset,
    handleRestoreAsset,
    pendingPermanentDeleteAssetId,
    setPendingPermanentDeleteAssetId,
    permanentlyDeletingAsset,
    handleConfirmPermanentDeleteAsset,
  } = useLibraryAssetActions({
    onAssetDeleted: (id) => {
      setProjectAssets((current) => current.filter((asset) => asset.id !== id));
      setAssetRefreshKey((key) => key + 1);
    },
    onAssetRestored: (asset) => {
      setProjectAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)]);
      setAssetRefreshKey((key) => key + 1);
    },
    projectId,
  });

  useEffect(() => {
    jobsLoadMoreControllerRef.current?.abort();
    jobsLoadMoreControllerRef.current = null;
    canvasSessionsLoadMoreControllerRef.current?.abort();
    canvasSessionsLoadMoreControllerRef.current = null;
    queueMicrotask(() => {
      setJobsLoadingMore(false);
      setCanvasSessionsLoadingMore(false);
      setJobsPageError("");
      setCanvasSessionsPageError("");
    });
    if (!projectId) {
      queueMicrotask(() => {
        setDetail(null);
        setDetailError("");
        setDetailLoading(false);
      });
      return;
    }
    // Skip the mount fetch when the server already hydrated this exact project
    // (avoids the skeleton flash + duplicate request on first visit). A reload
    // token (retry / completion refresh) always forces a fresh fetch.
    const alreadyHydrated = hydratedProjectRef.current === projectId && detailReloadToken === 0;
    if (alreadyHydrated) {
      hydratedProjectRef.current = null;
      return;
    }
    let active = true;
    const controller = new AbortController();
    queueMicrotask(() => {
      setDetail(null);
      setDetailError("");
      setDetailLoading(true);
    });
    const load = async () => {
      try {
        const payload = await fetchJson<ProjectActivityResponse>(
          `/api/projects/${projectId}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!active) return;
        const nextDetail = projectDetailFromResponse(projectId, payload);
        if (!nextDetail) {
          setDetailError(t("library.loadDetailFailed"));
          return;
        }
        setDetail(nextDetail);
        setDetailError("");
      } catch (requestError) {
        if (!active) return;
        setDetailError(toErrorMessage(requestError, t("library.loadDetailFailed")));
      } finally {
        if (active) setDetailLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
      controller.abort();
    };
    // t is read only for the error fallback; a re-fetch on rare locale flips is acceptable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, detailReloadToken]);

  // While a job is active, poll only its lightweight status projection. Each
  // request schedules the next tick after it settles, so slow responses cannot
  // overlap and multiply database work.
  const hasRunningJob = useMemo(
    () => (detail?.jobs ?? []).some((job) => isJobRunning(job.status)),
    [detail],
  );
  const prevRunningCountRef = useRef(0);
  const prevJobsSigRef = useRef("");
  useEffect(() => {
    if (!projectId || !hasRunningJob) return;
    let active = true;
    const controller = new AbortController();
    let timer: number | null = null;
    const poll = async () => {
      try {
        const payload = await fetchJson<ProjectJobStatusResponse>(
          `/api/projects/${projectId}/jobs/status`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!active) return;
        const nextSig = jobsSignature(payload.jobs);
        const runningNow = payload.jobs.filter((job) => isJobRunning(job.status)).length;
        let completedAssets: LibrarySearchResponse | null = null;
        if (runningNow < prevRunningCountRef.current) {
          const params = new URLSearchParams({ projectId, limit: String(ASSET_PAGE_SIZE) });
          completedAssets = await fetchJson<LibrarySearchResponse>(
            `/api/library/search?${params.toString()}`,
            { cache: "no-store", signal: controller.signal },
          ).catch(() => null);
        }
        if (!active) return;
        if (nextSig !== prevJobsSigRef.current) {
          prevJobsSigRef.current = nextSig;
          setDetail((current) =>
            current
              ? { ...current, jobs: mergeProjectJobs(current.jobs, payload.jobs) }
              : current,
          );
        }
        if (completedAssets) {
          setAssetCounts(completedAssets.counts);
          setProjectAssets((current) => {
            const existing = new Set(current.map((asset) => asset.id));
            const fresh = completedAssets.assets
              .filter((asset) => !existing.has(asset.id))
              .map(toLibraryAsset);
            return fresh.length > 0 ? [...fresh, ...current] : current;
          });
        }
        prevRunningCountRef.current = runningNow;
      } catch {
        // Transient poll failure: keep the last good detail, try again next tick.
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), JOB_POLL_MS);
      }
    };
    prevRunningCountRef.current = (detail?.jobs ?? []).filter((job) => isJobRunning(job.status)).length;
    prevJobsSigRef.current = jobsSignature(detail?.jobs ?? []);
    timer = window.setTimeout(() => void poll(), JOB_POLL_MS);
    return () => {
      active = false;
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
    // detail is intentionally excluded: we re-arm only when running-state flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, hasRunningJob]);

  useEffect(() => {
    if (!projectId) {
      queueMicrotask(() => {
        setProjectAssets([]);
        setAssetCounts(EMPTY_LIBRARY_SEARCH_COUNTS);
        setAssetError("");
        setAssetLoading(false);
        setAssetsHasMore(false);
        setAssetsCursor(null);
      });
      return;
    }
    assetLoadMoreControllerRef.current?.abort();
    assetLoadMoreControllerRef.current = null;
    queueMicrotask(() => setAssetLoadingMore(false));
    // First visit is server-hydrated and remains bounded to that first page.
    // Reloads fetch exactly one fresh first page; later pages are user-driven.
    const hydrated =
      assetsHydratedRef.current === projectId &&
      detailReloadToken === 0 &&
      assetReloadToken === 0;
    if (hydrated) {
      assetsHydratedRef.current = null;
      return;
    }
    const controller = new AbortController();
    queueMicrotask(() => {
      setProjectAssets([]);
      setAssetCounts(EMPTY_LIBRARY_SEARCH_COUNTS);
      setAssetError("");
      setAssetLoading(true);
      setAssetsHasMore(false);
      setAssetsCursor(null);
    });

    const loadAssets = async () => {
      try {
        const params = new URLSearchParams({ projectId, limit: String(ASSET_PAGE_SIZE) });
        const page = await fetchJson<LibrarySearchResponse>(
          `/api/library/search?${params.toString()}`,
          { cache: "no-store", signal: controller.signal },
        );
        setProjectAssets(page.assets.map(toLibraryAsset));
        setAssetCounts(page.counts);
        setAssetsHasMore(page.hasMore);
        setAssetsCursor(page.nextCursor);
        setAssetError("");
      } catch (requestError) {
        if (!controller.signal.aborted) {
          setAssetError(toErrorMessage(requestError, t("library.loadDetailFailed")));
        }
      } finally {
        if (!controller.signal.aborted) setAssetLoading(false);
      }
    };
    void loadAssets();
    return () => controller.abort();
    // t is read only for the error fallback; a re-fetch on rare locale flips is acceptable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, detailReloadToken, assetReloadToken]);

  const loadMoreProjectAssets = useCallback(async () => {
    if (!projectId || !assetsHasMore || !assetsCursor || assetLoadMoreControllerRef.current) {
      return;
    }
    const controller = new AbortController();
    assetLoadMoreControllerRef.current = controller;
    setAssetLoadingMore(true);
    try {
      const params = new URLSearchParams({
        projectId,
        limit: String(ASSET_PAGE_SIZE),
        cursor: assetsCursor,
      });
      const page = await fetchJson<LibrarySearchResponse>(
        `/api/library/search?${params.toString()}`,
        { cache: "no-store", signal: controller.signal },
      );
      setProjectAssets((current) => {
        const seen = new Set(current.map((asset) => asset.id));
        return [
          ...current,
          ...page.assets.filter((asset) => !seen.has(asset.id)).map(toLibraryAsset),
        ];
      });
      setAssetsHasMore(page.hasMore);
      setAssetsCursor(page.nextCursor);
      setAssetCounts(page.counts);
      setAssetError("");
    } catch (requestError) {
      if (!controller.signal.aborted) {
        setAssetError(toErrorMessage(requestError, t("library.loadDetailFailed")));
      }
    } finally {
      if (assetLoadMoreControllerRef.current === controller) {
        assetLoadMoreControllerRef.current = null;
      }
      if (!controller.signal.aborted) setAssetLoadingMore(false);
    }
  }, [projectId, assetsHasMore, assetsCursor, t]);

  useEffect(
    () => () => {
      assetLoadMoreControllerRef.current?.abort();
    },
    [],
  );

  const loadMoreJobs = useCallback(async () => {
    const cursor = detail?.jobsNextCursor;
    if (!detail?.jobsHasMore || !cursor || jobsLoadMoreControllerRef.current) return;

    const requestKey = projectId;
    const controller = new AbortController();
    jobsLoadMoreControllerRef.current = controller;
    setJobsLoadingMore(true);
    setJobsPageError("");
    try {
      const params = buildProjectActivitySearchParams("jobs", cursor);
      const payload = await fetchJson<ProjectActivityResponse>(
        `/api/projects/${projectId}?${params.toString()}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (controller.signal.aborted || jobsLoadMoreControllerRef.current !== controller) return;
      const jobsPage = payload.jobs;
      if (!jobsPage) {
        setJobsPageError(t("library.loadDetailFailed"));
        return;
      }

      setDetail((current) => {
        if (!current) return current;
        const currentPage = {
          key: current.key,
          items: current.jobs,
          hasMore: current.jobsHasMore,
          nextCursor: current.jobsNextCursor,
        };
        const merged = mergeKeyedCursorPage(currentPage, requestKey, jobsPage);
        if (merged === currentPage) return current;
        return {
          ...current,
          jobs: merged.items,
          jobsHasMore: merged.hasMore,
          jobsNextCursor: merged.nextCursor,
        };
      });
    } catch (requestError) {
      if (!controller.signal.aborted && jobsLoadMoreControllerRef.current === controller) {
        setJobsPageError(toErrorMessage(requestError, t("library.loadDetailFailed")));
      }
    } finally {
      if (jobsLoadMoreControllerRef.current === controller) {
        jobsLoadMoreControllerRef.current = null;
      }
      if (!controller.signal.aborted) setJobsLoadingMore(false);
    }
  }, [detail?.jobsHasMore, detail?.jobsNextCursor, projectId, t]);

  const loadMoreCanvasSessions = useCallback(async () => {
    const cursor = detail?.canvasSessionsNextCursor;
    if (
      !detail?.canvasSessionsHasMore ||
      !cursor ||
      canvasSessionsLoadMoreControllerRef.current
    ) {
      return;
    }

    const requestKey = projectId;
    const controller = new AbortController();
    canvasSessionsLoadMoreControllerRef.current = controller;
    setCanvasSessionsLoadingMore(true);
    setCanvasSessionsPageError("");
    try {
      const params = buildProjectActivitySearchParams("canvasSessions", cursor);
      const payload = await fetchJson<ProjectActivityResponse>(
        `/api/projects/${projectId}?${params.toString()}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        canvasSessionsLoadMoreControllerRef.current !== controller
      ) {
        return;
      }
      const canvasSessionsPage = payload.canvasSessions;
      if (!canvasSessionsPage) {
        setCanvasSessionsPageError(t("library.loadDetailFailed"));
        return;
      }

      setDetail((current) => {
        if (!current) return current;
        const currentPage = {
          key: current.key,
          items: current.canvasSessions,
          hasMore: current.canvasSessionsHasMore,
          nextCursor: current.canvasSessionsNextCursor,
        };
        const merged = mergeKeyedCursorPage(
          currentPage,
          requestKey,
          canvasSessionsPage,
        );
        if (merged === currentPage) return current;
        return {
          ...current,
          canvasSessions: merged.items,
          canvasSessionsHasMore: merged.hasMore,
          canvasSessionsNextCursor: merged.nextCursor,
        };
      });
    } catch (requestError) {
      if (
        !controller.signal.aborted &&
        canvasSessionsLoadMoreControllerRef.current === controller
      ) {
        setCanvasSessionsPageError(
          toErrorMessage(requestError, t("library.loadDetailFailed")),
        );
      }
    } finally {
      if (canvasSessionsLoadMoreControllerRef.current === controller) {
        canvasSessionsLoadMoreControllerRef.current = null;
      }
      if (!controller.signal.aborted) setCanvasSessionsLoadingMore(false);
    }
  }, [detail?.canvasSessionsHasMore, detail?.canvasSessionsNextCursor, projectId, t]);

  useEffect(
    () => () => {
      jobsLoadMoreControllerRef.current?.abort();
      canvasSessionsLoadMoreControllerRef.current?.abort();
    },
    [],
  );

  const sessions = useMemo(() => detail?.canvasSessions ?? [], [detail]);
  const { recent, older } = useMemo(() => partitionSessionsByRecency(sessions), [sessions]);

  // projects-10: a brand-new project (no sessions, no jobs, no assets) collapses
  // to ONE directed empty state with a primary CTA — not three stacked empties.
  // Per-section empties are reserved for partially-populated projects.
  // A failed asset fetch is not an empty project: state order is
  // loading → blocking error → empty → data, and the branches never coexist.
  const isFreshEmptyProject =
    Boolean(detail) &&
    sessions.length === 0 &&
    (detail?.jobs.length ?? 0) === 0 &&
    projectAssets.length === 0 &&
    !assetLoading &&
    !assetError;
  const assetsBlocked = Boolean(assetError) && projectAssets.length === 0 && !assetLoading;
  // An empty Canvas section owns the one directed Generate CTA. Once canvases
  // exist, the persistent project-header action becomes the primary shortcut.
  const showHeaderGenerate = !detail || sessions.length > 0;

  const handleGenerateHere = () => router.push("/studio");
  const handleOpenCanvas = (sessionId: string) => {
    try {
      router.push(
        addCanvasEntrySource(
          `/canvas/${encodeURIComponent(sessionId)}`,
          `project:${projectId}`,
        ),
      );
    } catch {
      setError(t("studio.canvasCreateFailed"));
    }
  };

  const handleRevealInFinder = async () => {
    try {
      await fetchJson(`/api/projects/${projectId}/reveal`, { method: "POST" });
    } catch (requestError) {
      // The button is desktop-gated, but if a stale web session ever reaches the
      // 400 reveal_desktop_only path, surface the precise reason rather than the
      // misleading generic "couldn't open the folder".
      const code =
        requestError instanceof HttpError &&
        requestError.payload &&
        typeof requestError.payload === "object"
          ? (requestError.payload as { code?: unknown }).code
          : undefined;
      setError(
        code === "reveal_desktop_only"
          ? t("library.revealDesktopOnly")
          : toErrorMessage(requestError, t("library.revealFailed")),
      );
    }
  };

  const openProjectNameDialog = () => {
    setProjectNameDraft(projectName);
    setProjectNameError("");
    setProjectNameDialogOpen(true);
  };

  const handleRenameProject = async (name: string) => {
    if (savingProjectName) return;
    setSavingProjectName(true);
    setProjectNameError("");
    try {
      const project = await renameProject(projectId, name);
      setProjectName(project.name);
      announceProjectUpdated(project);
      setProjectNameDialogOpen(false);
    } catch (requestError) {
      setProjectNameError(toErrorMessage(requestError, t("library.renameProjectFailed")));
    } finally {
      setSavingProjectName(false);
    }
  };

  const handleConfirmDeleteSession = async () => {
    if (!pendingDeleteSession) return;
    const sessionId = pendingDeleteSession.id;
    try {
      setDeletingSession(true);
      await fetchJson(`/api/canvas/sessions/${sessionId}`, { method: "DELETE" });
      setDetail((current) =>
        current
          ? {
              ...current,
              canvasSessions: current.canvasSessions.filter((s) => s.id !== sessionId),
            }
          : current,
      );
      onSessionDeleted?.(sessionId);
    } catch (requestError) {
      setError(toErrorMessage(requestError, t("library.deleteSessionFailed")));
    } finally {
      setDeletingSession(false);
      setPendingDeleteSession(null);
    }
  };

  const startRenameSession = (session: ProjectDetailSession) => {
    setRenamingSessionId(session.id);
    setRenameDraft(session.title);
  };
  const cancelRenameSession = () => {
    setRenamingSessionId(null);
    setRenameDraft("");
  };
  const commitRenameSession = async () => {
    if (!renamingSessionId) return;
    const next = renameDraft.trim();
    if (!next) {
      cancelRenameSession();
      return;
    }
    const sessionId = renamingSessionId;
    try {
      setSavingRename(true);
      const payload = await fetchJson<{ session: { id: string; title: string } }>(
        `/api/canvas/sessions/${sessionId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: next }),
        },
      );
      setDetail((current) =>
        current
          ? {
              ...current,
              canvasSessions: current.canvasSessions.map((session) =>
                session.id === sessionId
                  ? { ...session, title: payload.session.title }
                  : session,
              ),
            }
          : current,
      );
    } catch (requestError) {
      setError(toErrorMessage(requestError, t("library.renameSessionFailed")));
    } finally {
      setSavingRename(false);
      setRenamingSessionId(null);
      setRenameDraft("");
    }
  };

  const renderSessionRow = (session: ProjectDetailSession) => {
    const isRenaming = renamingSessionId === session.id;
    return (
      <HoverLiftCard key={session.id} hoverY={-1}>
        <div className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-(--bg-glass)">
          <div className="min-w-0 flex-1">
            {isRenaming ? (
              <div className="flex items-center gap-1.5">
                <Input
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitRenameSession();
                    } else if (event.key === "Escape") {
                      cancelRenameSession();
                    }
                  }}
                  placeholder={t("studio.taskIntents.renameSessionPlaceholder")}
                  disabled={savingRename}
                  className="h-7 text-sm"
                />
                <Button
                  type="button"
                  onClick={() => void commitRenameSession()}
                  disabled={savingRename}
                  aria-label={t("studio.taskIntents.saveSession")}
                  variant="ghost"
                  size="icon-xs"
                  className="text-(--success) hover:bg-(--success-soft)"
                >
                  <Check className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  onClick={cancelRenameSession}
                  disabled={savingRename}
                  aria-label={t("common.cancel")}
                  variant="ghostMuted"
                  size="icon-xs"
                  className="hover:bg-(--bg-surface)"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <>
                <p className="truncate text-sm font-semibold text-(--text-primary)">{session.title}</p>
                <p className="text-xs text-(--text-muted)">
                  {t("library.sessionInfo", {
                    layerCount: session.layerCount,
                    updatedAt: relativeTime(session.updatedAt, t),
                  })}
                </p>
              </>
            )}
          </div>
          {!isRenaming ? (
            <div className="flex items-center gap-1">
              <Button type="button" onClick={() => handleOpenCanvas(session.id)} variant="secondary" size="sm">
                {t("studio.taskIntents.openSession")}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    aria-label={t("assetActions.more")}
                    variant="ghostMuted"
                    size="icon-sm"
                    className="size-9 max-sm:size-10 hover:bg-(--bg-surface)"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem onSelect={() => startRenameSession(session)}>
                    <PencilLine className="h-4 w-4" />
                    {t("studio.taskIntents.renameSession")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setPendingDeleteSession(session)}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t("studio.taskIntents.deleteSession")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
        </div>
      </HoverLiftCard>
    );
  };

  return (
    <>
      {notice ? (
        <Alert className="mb-4 border-primary/30 bg-primary/10 text-primary">
          <AlertDescription className="justify-center text-xs font-medium text-primary">
            {notice}
          </AlertDescription>
        </Alert>
      ) : null}
      <div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 space-y-1.5">
            <Button asChild variant="ghostMuted" size="sm" className="-ml-2 w-fit px-2 text-xs">
              <TransitionLink href="/projects">
                <ArrowLeft className="h-3.5 w-3.5" />
                {t("library.backToProjects")}
              </TransitionLink>
            </Button>
            <div className="flex min-w-0 items-center gap-1">
              <h1 className="truncate text-lg font-semibold tracking-[-0.01em] text-(--text-primary)">
                {projectName}
              </h1>
              <Button
                type="button"
                variant="ghostMuted"
                size="icon-xs"
                aria-label={t("library.renameProject")}
                onClick={openProjectNameDialog}
              >
                <PencilLine className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {showHeaderGenerate ? (
              <Button type="button" variant="accent" size="sm" onClick={handleGenerateHere}>
                <Sparkles className="h-3.5 w-3.5" />
                {t("library.generateHere")}
              </Button>
            ) : null}
            {desktopAvailable ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => void handleRevealInFinder()}>
                <FolderOpen className="h-3.5 w-3.5" />
                {t("library.revealInFinder")}
              </Button>
            ) : null}
          </div>
        </div>
        {detailLoading ? (
          <div className="mt-4 space-y-2" aria-busy="true">
            <Skeleton className="h-14 rounded-xl bg-(--bg-elevated)" />
            <Skeleton className="h-14 rounded-xl bg-(--bg-elevated)" />
            <Skeleton className="h-32 rounded-xl bg-(--bg-elevated)" />
          </div>
        ) : detailError ? (
          <div className="mt-4 flex flex-col items-start gap-3 rounded-xl bg-destructive/5 p-4">
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {detailError}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => setDetailReloadToken((n) => n + 1)}>
              {t("library.retry")}
            </Button>
          </div>
        ) : !detail ? (
          <EmptyStateCard className="mt-4">
            <FolderOpen className="mx-auto mb-2 h-6 w-6 text-(--text-muted)" />
            {t("common.noData")}
          </EmptyStateCard>
        ) : isFreshEmptyProject ? (
          <EmptyStateCard className="mt-4">
            <Sparkles className="mx-auto mb-3 h-7 w-7 text-(--accent-primary)" />
            <p className="text-sm font-semibold text-(--text-primary)">{t("library.emptyProjectTitle")}</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-(--text-muted)">{t("library.emptyProjectBody")}</p>
            <Button type="button" variant="accent" size="sm" className="mt-4" onClick={handleGenerateHere}>
              <Sparkles className="h-3.5 w-3.5" />
              {t("library.generateHere")}
            </Button>
          </EmptyStateCard>
        ) : (
          <div className="mt-4 space-y-5">
            <div className="space-y-2">
              <p className="text-xs font-semibold text-(--text-muted)">{t("library.canvasSessionsLabel")}</p>
              {sessions.length === 0 ? (
                // Genuinely zero sessions → one directed Empty (title + one action),
                // not a bare dashed one-liner. Never shown when older sessions exist.
                <Empty className="py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Sparkles />
                    </EmptyMedia>
                    <EmptyTitle>{t("library.noCanvasSessions")}</EmptyTitle>
                  </EmptyHeader>
                  <Button type="button" variant="accent" size="sm" onClick={handleGenerateHere}>
                    <Sparkles className="h-3.5 w-3.5" />
                    {t("library.generateHere")}
                  </Button>
                </Empty>
              ) : recent.length > 0 ? (
                <>
                  <p className="text-xs font-medium text-(--text-muted)/80">
                    {t("library.canvasSessionsRecent")}
                  </p>
                  <div className="divide-y divide-(--border-subtle)">
                    {recent.map(renderSessionRow)}
                  </div>
                </>
              ) : null}
              {/* No recent sessions but older ones exist → render nothing here; the
                  "Older (N)" group below carries them, so we never claim "no
                  sessions" while also listing older ones. */}
            </div>

            {older.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-(--text-muted)/80">
                  {t("studio.taskIntents.sessionsOlder")} ({older.length})
                </p>
                <div className="divide-y divide-(--border-subtle)">
                  {older.map(renderSessionRow)}
                </div>
              </div>
            ) : null}
            {detail.canvasSessionsHasMore ? (
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  loading={canvasSessionsLoadingMore}
                  onClick={() => void loadMoreCanvasSessions()}
                >
                  {t("studio.libraryTabs.loadMore")}
                </Button>
              </div>
            ) : null}
            {canvasSessionsPageError ? (
              <p role="alert" className="text-center text-sm text-destructive">
                {canvasSessionsPageError}
              </p>
            ) : null}

            <div className="space-y-2">
              <p className="text-xs font-semibold text-(--text-muted)">
                {detail.jobsHasMore
                  ? t("library.recentGenerations")
                  : t("library.generations")}
              </p>
              {detail.jobs.length === 0 ? (
                <p className="rounded-xl border border-dashed border-(--border-subtle) px-3 py-2 text-sm text-(--text-muted)">
                  {t("common.noData")}
                </p>
              ) : (
                <>
                  <div className="divide-y divide-(--border-subtle)">
                    {detail.jobs.map((job) => {
                    const running = isJobRunning(job.status);
                    const tone =
                      job.status === "SUCCEEDED"
                        ? "text-(--success)"
                        : job.status === "FAILED"
                          ? "text-destructive"
                          : job.status === "PARTIAL"
                            ? "text-(--warning)"
                            : "text-(--text-muted)";
                    return (
                      <HoverLiftCard key={job.id} hoverY={-1}>
                        <div className="p-3">
                          <div className="flex items-start justify-between gap-3">
                            <p className="line-clamp-1 min-w-0 flex-1 text-sm text-(--text-primary)">
                              {job.prompt || job.status}
                            </p>
                            {running ? (
                              <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-(--accent-primary)">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                {t("library.jobGenerating")}
                              </span>
                            ) : (
                              <span
                                className={`flex shrink-0 items-center gap-1 text-xs font-semibold ${tone}`}
                                title={t("library.jobSuccessRatio", { done: job.successCount, total: job.requestedCount })}
                              >
                                {job.status === "SUCCEEDED" ? (
                                  <Check className="h-3.5 w-3.5" aria-hidden />
                                ) : job.status === "FAILED" ? (
                                  <X className="h-3.5 w-3.5" aria-hidden />
                                ) : job.status === "PARTIAL" ? (
                                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                                ) : null}
                                {t("library.jobSuccessRatio", { done: job.successCount, total: job.requestedCount })}
                              </span>
                            )}
                          </div>
                        </div>
                      </HoverLiftCard>
                    );
                    })}
                  </div>
                  {detail.jobsHasMore ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full"
                      loading={jobsLoadingMore}
                      onClick={() => void loadMoreJobs()}
                    >
                      {t("studio.libraryTabs.loadMore")}
                    </Button>
                  ) : null}
                  {jobsPageError ? (
                    <p role="alert" className="text-center text-sm text-destructive">
                      {jobsPageError}
                    </p>
                  ) : null}
                </>
              )}
            </div>

            {assetLoading && projectAssets.length === 0 ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-10 rounded-xl bg-(--bg-elevated)" />
                <Skeleton className="h-32 rounded-xl bg-(--bg-elevated)" />
              </div>
            ) : assetsBlocked ? (
              // First-load failure blocks the asset region entirely: showing the
              // grid's "no assets" empty state here would claim the project is
              // empty when we simply never loaded it.
              <div
                role="alert"
                className="flex flex-col items-start gap-3 rounded-xl bg-destructive/5 p-4"
              >
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {assetError}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAssetReloadToken((n) => n + 1)}
                >
                  {t("library.retry")}
                </Button>
              </div>
            ) : (
              <LibraryAssetTabs
                key={projectId}
                assets={projectAssets}
                counts={assetCounts}
                onCountsChange={setAssetCounts}
                projectId={projectId}
                refreshKey={assetRefreshKey}
                showProjectContext={false}
                highlightedAssetId={highlightedAssetId}
                hasRemoteMore={assetsHasMore && Boolean(assetsCursor)}
                isLoadingMore={assetLoadingMore}
                onLoadMore={() => void loadMoreProjectAssets()}
                onUseAsReference={handleUseAsReference}
                onOpenInCanvas={(id) => void handleOpenInCanvas(id)}
                openingCanvasAssetId={openingCanvasAssetId}
                canvasActionError={canvasActionError}
                onDelete={(id) => setPendingDeleteAssetId(id)}
                onRestore={(id) => void handleRestoreAsset(id)}
                onPermanentDelete={(id) => setPendingPermanentDeleteAssetId(id)}
              />
            )}
            {/* Refresh / load-more failures may coexist with retained data. */}
            {assetError && !assetsBlocked ? (
              <p role="alert" className="text-sm text-destructive">
                {assetError}
              </p>
            ) : null}
          </div>
        )}
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      </div>

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
      <ProjectNameDialog
        open={projectNameDialogOpen}
        name={projectNameDraft}
        title={t("library.renameProject")}
        description={t("library.projectNameDescription")}
        inputLabel={t("agent.projectName")}
        submitLabel={t("common.save")}
        cancelLabel={t("common.cancel")}
        pending={savingProjectName}
        error={projectNameError}
        onNameChange={setProjectNameDraft}
        onOpenChange={(open) => {
          setProjectNameDialogOpen(open);
          if (!open) setProjectNameError("");
        }}
        onSubmit={handleRenameProject}
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
      <ConfirmActionDialog
        open={Boolean(pendingDeleteSession)}
        onOpenChange={(open) => {
          if (!open && !deletingSession) setPendingDeleteSession(null);
        }}
        title={t("studio.taskIntents.deleteSession")}
        description={t("studio.taskIntents.deleteSessionConfirm")}
        cancelLabel={t("common.cancel")}
        confirmLabel={deletingSession ? t("library.deleting") : t("common.delete")}
        pending={deletingSession}
        tone="destructive"
        onConfirm={handleConfirmDeleteSession}
      />
    </>
  );
}
