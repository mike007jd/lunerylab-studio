/**
 * GET /api/library/search — cross-project asset search with filters + paging.
 *
 * Query parameters (all optional):
 *   q          full-text match against jobs.prompt
 *   modality   "IMAGE" | "VIDEO" | "MODEL_3D"
 *   kind       "REFERENCE" | "GENERATED"
 *   origin     "USER" | "TEMPLATE"
 *   tag        repeated; ANY-match
 *   favorite   "1" to filter to favorites only
 *   projectId  filter to a single project
 *   assetId    exact asset lookup for library deep links
 *   trash      "1" to return recoverable soft-deleted assets
 *   countsOnly "1" to skip row hydration and return scope counts only
 *   limit      default 48, max 200
 *   cursor     opaque cursor returned by the previous page (asset id)
 *
 * Replaces the implicit `take: 100` hard cap on the project details endpoint
 * for any user view that needs to look across more than a single project.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/server/prisma";
import type { Prisma } from "@prisma/client";
import { jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { toAssetDTO, toVisibleAssetJobProvenance } from "@/lib/server/dto";
import {
  fetchLibraryAssetCounts,
  withVisibleLibraryAssetScope,
} from "@/lib/server/library-asset-counts";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 48;

export async function GET(request: NextRequest) {
  try {
    const user = await requireLocalWorkspaceOwner();

    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim() || undefined;
    const modalityParam = url.searchParams.get("modality")?.trim();
    const kindParam = url.searchParams.get("kind")?.trim();
    const originParam = url.searchParams.get("origin")?.trim();
    const projectId = url.searchParams.get("projectId")?.trim() || undefined;
    const assetId = url.searchParams.get("assetId")?.trim() || undefined;
    const favoriteOnly = url.searchParams.get("favorite") === "1";
    const countsOnly = url.searchParams.get("countsOnly") === "1";
    const trashOnly = url.searchParams.get("trash") === "1";
    const tags = url.searchParams.getAll("tag").map((t) => t.trim()).filter(Boolean);
    const rawLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(MAX_LIMIT, Math.round(rawLimit)))
      : DEFAULT_LIMIT;
    const cursor = url.searchParams.get("cursor")?.trim() || undefined;

    const modality =
      modalityParam === "IMAGE" || modalityParam === "VIDEO" || modalityParam === "MODEL_3D"
        ? modalityParam
        : undefined;
    const kind = kindParam === "REFERENCE" || kindParam === "GENERATED" ? kindParam : undefined;
    const origin = originParam === "USER" || originParam === "TEMPLATE" ? originParam : undefined;

    // Counts intentionally ignore the active kind/modality tab so every tab can
    // show a truthful whole-library total for the current text/project filters.
    // The row query below adds the active tab back in.
    const countWhere: Prisma.AssetWhereInput = {
      userId: user.id,
      ...(assetId ? { id: assetId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(favoriteOnly ? { isFavorite: true } : {}),
      ...(tags.length > 0 ? { tags: { hasSome: tags } } : {}),
      ...(q
        ? {
            OR: [
              {
                origin: "USER",
                job: { prompt: { contains: q, mode: "insensitive" } },
              },
              {
                origin: "TEMPLATE",
                project: { is: { name: { contains: q, mode: "insensitive" } } },
              },
            ],
          }
        : {}),
    };
    const where: Prisma.AssetWhereInput = {
      ...countWhere,
      deletedAt: trashOnly ? { not: null } : null,
      ...(modality ? { modality } : {}),
      ...(kind ? { kind } : {}),
      ...(origin ? { origin } : {}),
    };

    if (countsOnly) {
      const counts = await fetchLibraryAssetCounts(countWhere);
      return NextResponse.json({
        assets: [],
        nextCursor: null,
        hasMore: false,
        limit: 0,
        counts,
      });
    }

    const [rows, counts] = await Promise.all([
      prisma.asset.findMany({
        where: withVisibleLibraryAssetScope(where),
        include: {
          job: { select: { prompt: true, provider: true, model: true } },
          project: { select: { name: true } },
          agentTask: { select: { id: true, prompt: true } },
        },
        orderBy: [{ isFavorite: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      fetchLibraryAssetCounts(countWhere),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    return NextResponse.json({
      assets: page.map((asset) => ({
        ...toAssetDTO(asset),
        ...toVisibleAssetJobProvenance(asset),
        projectName: asset.project?.name ?? null,
        agentTaskSummary: asset.agentTask?.prompt ?? null,
      })),
      nextCursor,
      hasMore,
      limit,
      counts,
    });
  } catch (error) {
    return jsonError(error);
  }
}
