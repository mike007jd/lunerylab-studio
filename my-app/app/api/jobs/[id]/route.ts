import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/server/prisma";
import { ApiError, jsonError } from "@/lib/server/errors";
import { toAssetDTO } from "@/lib/server/dto";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;

    const job = await prisma.generationJob.findUnique({
      where: { id, userId: user.id },
      include: {
        assets: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
    });

    if (!job) {
      throw new ApiError({
        status: 404,
        code: "job_not_found",
        message: "Job not found.",
        retryable: false,
      });
    }

    return NextResponse.json({
      job: {
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
      },
      assets: job.assets.map(toAssetDTO),
    });
  } catch (error) {
    return jsonError(error);
  }
}
