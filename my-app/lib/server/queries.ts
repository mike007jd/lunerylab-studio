import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { getLocalWorkspacePreferences } from "@/lib/server/local-workspace-owner";
import { getProviderStatus, type ProviderStatus } from "@/lib/server/api-keys";
import {
  listByokConnectionMeta,
  type ByokConnectionMeta,
} from "@/lib/server/byok-connection-store";
import { toAssetDTO, toVisibleAssetJobProvenance } from "@/lib/server/dto";
import type { AssetDTO, ContentOrigin } from "@/lib/types/api";
import { SIDEBAR_RECENT_PROJECT_LIMIT } from "@/lib/constants/shell-navigation";
import type { LibrarySearchCounts } from "@/lib/library-search";
import {
  fetchLibraryAssetCounts,
  withVisibleLibraryAssetScope,
} from "@/lib/server/library-asset-counts";
import {
  createCursorPage,
  normalizeCursorPageSize,
  PROJECT_CANVAS_SESSIONS_PAGE_SIZE,
  PROJECT_JOBS_PAGE_SIZE,
  PROJECTS_PAGE_SIZE,
  type CursorPage,
  type ProjectActivityJob,
  type ProjectActivityResponse,
  type ProjectActivitySession,
} from "@/lib/project-pagination";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapData {
  app: {
    defaultLocale: string;
    defaultTextModel: string;
    defaultImageModel: string;
    defaultVideoModel: string;
  };
  providers: Record<string, ProviderStatus>;
  providerConnections: Record<string, ByokConnectionMeta>;
}

export async function fetchBootstrapData(userId: string): Promise<BootstrapData> {
  const [settings, providers] = await Promise.all([
    getLocalWorkspacePreferences(userId),
    getProviderStatus(),
  ]);

  return {
    app: {
      defaultLocale: settings.defaultLocale,
      defaultTextModel: settings.defaultTextModel,
      defaultImageModel: settings.defaultImageModel,
      defaultVideoModel: settings.defaultVideoModel,
    },
    providers,
    providerConnections: listByokConnectionMeta(),
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectData {
  id: string;
  name: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  jobCount: number;
  assetCount: number;
  canvasSessionCount: number;
}

export interface FetchProjectsPage {
  projects: ProjectData[];
  hasMore: boolean;
  nextCursor: string | null;
}

interface FetchProjectsOptions {
  cursor?: string;
  limit?: number;
}

export async function fetchProjects(
  userId: string,
  options: FetchProjectsOptions = {},
): Promise<FetchProjectsPage> {
  const pageSize = normalizeCursorPageSize(options.limit, PROJECTS_PAGE_SIZE, 100);
  const rows = await prisma.project.findMany({
    where: { userId, isTemplate: false },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: pageSize + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    include: {
      _count: {
        select: {
          jobs: { where: { origin: "USER" } },
          assets: true,
          canvasSessions: true,
        },
      },
    },
  });
  const page = createCursorPage(rows, pageSize);

  return {
    projects: page.items.map((project) => ({
      id: project.id,
      name: project.name,
      category: project.category,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      jobCount: project._count.jobs,
      assetCount: project._count.assets,
      canvasSessionCount: project._count.canvasSessions,
    })),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

export async function fetchProjectOptions(
  userId: string,
): Promise<Array<{ id: string; name: string }>> {
  return prisma.project.findMany({
    where: { userId, isTemplate: false },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true, name: true },
  });
}

export type ProjectWorkspaceSession = ProjectActivitySession;
export type ProjectWorkspaceJob = ProjectActivityJob;

export interface ProjectWorkspaceData {
  project: { id: string; name: string };
  canvasSessions: CursorPage<ProjectWorkspaceSession>;
  jobs: CursorPage<ProjectWorkspaceJob>;
  assets: Array<{
    id: string;
    kind: string;
    origin: ContentOrigin;
    url: string;
    mimeType: string;
    createdAt: string;
    prompt: string | null;
    provider: string | null;
    model: string | null;
    agentTaskId: string | null;
    agentTaskSummary: string | null;
    parentAssetId: string | null;
    summary: string | null;
    deletedAt: string | null;
    projectId: string | null;
    projectName: string | null;
  }>;
  assetCounts: LibrarySearchCounts;
  assetsHasMore: boolean;
  assetsNextCursor: string | null;
}

interface FetchProjectActivityOptions {
  section?: "all" | "jobs" | "canvasSessions";
  jobsCursor?: string;
  canvasSessionsCursor?: string;
  jobsLimit?: number;
  canvasSessionsLimit?: number;
}

export async function fetchProjectActivity(
  userId: string,
  id: string,
  options: FetchProjectActivityOptions = {},
): Promise<ProjectActivityResponse | null> {
  const section = options.section ?? "all";
  const includeJobs = section === "all" || section === "jobs";
  const includeCanvasSessions = section === "all" || section === "canvasSessions";
  const jobsLimit = normalizeCursorPageSize(
    options.jobsLimit,
    PROJECT_JOBS_PAGE_SIZE,
    50,
  );
  const canvasSessionsLimit = normalizeCursorPageSize(
    options.canvasSessionsLimit,
    PROJECT_CANVAS_SESSIONS_PAGE_SIZE,
    50,
  );

  const [project, jobRows, canvasSessionRows] = await Promise.all([
    prisma.project.findUnique({
      where: { id, userId },
      select: {
        id: true,
        name: true,
        category: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    includeJobs
      ? prisma.generationJob.findMany({
          where: { projectId: id, userId, origin: "USER" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: jobsLimit + 1,
          ...(options.jobsCursor
            ? { cursor: { id: options.jobsCursor }, skip: 1 }
            : {}),
          select: {
            id: true,
            status: true,
            prompt: true,
            requestedCount: true,
            successCount: true,
            createdAt: true,
          },
        })
      : Promise.resolve(null),
    includeCanvasSessions
      ? prisma.canvasSession.findMany({
          where: { projectId: id, userId },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: canvasSessionsLimit + 1,
          ...(options.canvasSessionsCursor
            ? { cursor: { id: options.canvasSessionsCursor }, skip: 1 }
            : {}),
          select: {
            id: true,
            title: true,
            status: true,
            zoom: true,
            panX: true,
            panY: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { layers: true } },
          },
        })
      : Promise.resolve(null),
  ]);

  if (!project) return null;

  const jobs = jobRows ? createCursorPage(jobRows, jobsLimit) : null;
  const canvasSessions = canvasSessionRows
    ? createCursorPage(canvasSessionRows, canvasSessionsLimit)
    : null;

  return {
    project: {
      id: project.id,
      name: project.name,
      category: project.category,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    },
    jobs: jobs
      ? {
          ...jobs,
          items: jobs.items.map((job) => ({
            ...job,
            createdAt: job.createdAt.toISOString(),
          })),
        }
      : null,
    canvasSessions: canvasSessions
      ? {
          ...canvasSessions,
          items: canvasSessions.items.map((session) => ({
            id: session.id,
            title: session.title,
            status: session.status,
            zoom: session.zoom,
            panX: session.panX,
            panY: session.panY,
            layerCount: session._count.layers,
            createdAt: session.createdAt.toISOString(),
            updatedAt: session.updatedAt.toISOString(),
          })),
        }
      : null,
  };
}

/** Server-side hydration for the /projects/[id] workspace: project meta,
 * recent canvas/job pages and the first asset page — so the client
 * mounts with data instead of waterfalling fetches + skeletons every visit.
 * Mirrors the /api/projects/[id] + /api/library/search shapes the client
 * continues paginating from. */
export async function fetchProjectWorkspace(
  userId: string,
  id: string,
  assetLimit = 200,
): Promise<ProjectWorkspaceData | null> {
  const pageSize = Math.max(1, Math.min(200, Math.floor(assetLimit)));
  const [activity, assetRows, assetCounts] = await Promise.all([
    fetchProjectActivity(userId, id),
    prisma.asset.findMany({
      where: withVisibleLibraryAssetScope({ projectId: id, userId, deletedAt: null }),
      orderBy: [{ isFavorite: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: pageSize + 1,
      select: {
        id: true,
        projectId: true,
        kind: true,
        origin: true,
        mimeType: true,
        createdAt: true,
        agentTaskId: true,
        parentAssetId: true,
        summary: true,
        generationSeed: true,
        generationSteps: true,
        generationCfg: true,
        negativePrompt: true,
        generationModel: true,
        deletedAt: true,
        agentTask: { select: { prompt: true } },
        job: { select: { prompt: true, provider: true, model: true } },
      },
    }),
    fetchLibraryAssetCounts({ userId, projectId: id }),
  ]);
  if (!activity || !activity.jobs || !activity.canvasSessions) return null;

  const assets = createCursorPage(assetRows, pageSize);

  return {
    project: { id: activity.project.id, name: activity.project.name },
    canvasSessions: activity.canvasSessions,
    jobs: activity.jobs,
    assets: assets.items.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      origin: asset.origin,
      url: `/api/assets/${asset.id}`,
      mimeType: asset.mimeType,
      createdAt: asset.createdAt.toISOString(),
      ...toVisibleAssetJobProvenance(asset),
      agentTaskId: asset.agentTaskId,
      agentTaskSummary: asset.agentTask?.prompt ?? null,
      parentAssetId: asset.parentAssetId,
      summary: asset.summary,
      generationSeed: asset.generationSeed,
      generationSteps: asset.generationSteps,
      generationCfg: asset.generationCfg,
      negativePrompt: asset.negativePrompt,
      generationModel: asset.generationModel,
      deletedAt: asset.deletedAt?.toISOString() ?? null,
      projectId: asset.projectId,
      projectName: activity.project.name,
    })),
    assetCounts,
    assetsHasMore: assets.hasMore,
    assetsNextCursor: assets.nextCursor,
  };
}

/** Lean id+name list for the sidebar Projects section — no counts/subqueries. */
export async function fetchSidebarProjects(
  userId: string,
): Promise<Array<{ id: string; name: string }>> {
  return prisma.project.findMany({
    where: { userId, isTemplate: false },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true, name: true },
    take: SIDEBAR_RECENT_PROJECT_LIMIT,
  });
}

export interface FetchLibraryAssetsPage {
  assets: Array<{
    id: string;
    kind: string;
    origin: ContentOrigin;
    url: string;
    mimeType: string;
    createdAt: string;
    prompt: string | null;
    provider: string | null;
    model: string | null;
    agentTaskId: string | null;
    agentTaskSummary: string | null;
    parentAssetId: string | null;
    summary: string | null;
    deletedAt: string | null;
    projectId: string | null;
    projectName: string | null;
  }>;
  counts: LibrarySearchCounts;
  hasMore: boolean;
  nextCursor: string | null;
}

/** Flat cross-project asset list (incl. unassigned) for the Library all-view.
 * Joins each asset's originating job prompt for in-gallery search. Returns the
 * first cursor page; the client continues through /api/library/search. */
export async function fetchLibraryAssets(
  userId: string,
  limit = 200,
): Promise<FetchLibraryAssetsPage> {
  const pageSize = Math.max(1, Math.min(200, Math.floor(limit)));
  const [rows, counts] = await Promise.all([
    prisma.asset.findMany({
      where: withVisibleLibraryAssetScope({ userId, deletedAt: null }),
      orderBy: [{ isFavorite: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: pageSize + 1,
      select: {
        id: true,
        projectId: true,
        kind: true,
        origin: true,
        mimeType: true,
        createdAt: true,
        agentTaskId: true,
        parentAssetId: true,
        summary: true,
        generationSeed: true,
        generationSteps: true,
        generationCfg: true,
        negativePrompt: true,
        generationModel: true,
        deletedAt: true,
        agentTask: { select: { prompt: true } },
        project: { select: { name: true } },
        job: { select: { prompt: true, provider: true, model: true } },
      },
    }),
    fetchLibraryAssetCounts({ userId }),
  ]);
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  return {
    assets: page.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      origin: asset.origin,
      url: `/api/assets/${asset.id}`,
      mimeType: asset.mimeType,
      createdAt: asset.createdAt.toISOString(),
      ...toVisibleAssetJobProvenance(asset),
      agentTaskId: asset.agentTaskId,
      agentTaskSummary: asset.agentTask?.prompt ?? null,
      parentAssetId: asset.parentAssetId,
      summary: asset.summary,
      generationSeed: asset.generationSeed,
      generationSteps: asset.generationSteps,
      generationCfg: asset.generationCfg,
      negativePrompt: asset.negativePrompt,
      generationModel: asset.generationModel,
      deletedAt: asset.deletedAt?.toISOString() ?? null,
      projectId: asset.projectId,
      projectName: asset.project?.name ?? null,
    })),
    counts,
    hasMore,
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
  };
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface FetchAssetsOptions {
  unassigned?: boolean;
  /** Pagination cursor — caller passes back `nextCursor` from the prior page. */
  cursor?: string;
  /** Page size; clamped to [1, 100]. */
  limit?: number;
}

export interface FetchAssetsPage {
  assets: AssetDTO[];
  hasMore: boolean;
  nextCursor: string | null;
}

export async function fetchAssets(
  userId: string,
  options: FetchAssetsOptions = {},
): Promise<FetchAssetsPage> {
  const where: Prisma.AssetWhereInput = {
    userId,
    deletedAt: null,
    ...(options.unassigned ? { projectId: { equals: null } } : {}),
  };
  const requested = options.limit;
  const PAGE_SIZE = Number.isFinite(requested)
    ? Math.max(1, Math.min(100, Math.floor(requested as number)))
    : 50;

  // Cursor pagination: take PAGE_SIZE + 1; the extra row indicates `hasMore`.
  const rows = await prisma.asset.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
    ...(options.cursor ? { skip: 1, cursor: { id: options.cursor } } : {}),
  });
  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  return {
    assets: page.map(toAssetDTO),
    hasMore,
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
  };
}
