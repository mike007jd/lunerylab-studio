import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/server/prisma";
import { jsonError } from "@/lib/server/errors";
import { toAssetDTO } from "@/lib/server/dto";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";

export async function GET(request: NextRequest) {
  try {
    const user = await requireLocalWorkspaceOwner();

    const projectId = request.nextUrl.searchParams.get("projectId")?.trim();
    const cursor = request.nextUrl.searchParams.get("cursor")?.trim() || undefined;
    const requestedLimit = Number(request.nextUrl.searchParams.get("limit"));
    const PAGE_SIZE = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(100, Math.floor(requestedLimit)))
      : 50;

    // Cursor pagination: fetch PAGE_SIZE+1 rows; if we got the extra one, the
    // client has more pages. The last in-page row's id is the next cursor.
    const rows = await prisma.generationJob.findMany({
      where: {
        userId: user.id,
        origin: "USER",
        ...(projectId ? { projectId } : {}),
      },
      include: {
        assets: {
          where: { kind: "GENERATED" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    const hasMore = rows.length > PAGE_SIZE;
    const jobs = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const nextCursor = hasMore ? jobs[jobs.length - 1]?.id ?? null : null;

    return NextResponse.json({
      jobs: jobs.map((job) => ({
        id: job.id,
        projectId: job.projectId,
        source: job.source,
        toolType: job.toolType,
        prompt: job.prompt,
        referenceCount: job.referenceCount,
        requestedCount: job.requestedCount,
        successCount: job.successCount,
        status: job.status,
        provider: job.provider,
        model: job.model,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt?.toISOString() ?? null,
        assets: job.assets.map(toAssetDTO),
      })),
      hasMore,
      nextCursor,
    });
  } catch (error) {
    return jsonError(error);
  }
}
