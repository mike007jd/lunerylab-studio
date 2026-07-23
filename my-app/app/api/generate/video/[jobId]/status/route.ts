// Pure DB poll. The desktop-local background worker is responsible for writing
// the asset row and marking the job SUCCEEDED or FAILED.
// This endpoint just reflects the latest persisted state to the client.

import { NextRequest, NextResponse } from "next/server";
import { assertVideoGenerationPrismaSupport, prisma } from "@/lib/server/prisma";
import { ApiError, jsonError } from "@/lib/server/errors";
import { toAssetDTO } from "@/lib/server/dto";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { VIDEO_JOB_TIMEOUT_MS } from "@/lib/constants/video-generation";

function runningResponse() {
  return NextResponse.json({ status: "RUNNING" });
}

function failedResponse(error: string) {
  return NextResponse.json({ status: "FAILED", error });
}

function succeededResponse(asset: ReturnType<typeof toAssetDTO> | null) {
  return NextResponse.json({ status: "SUCCEEDED", asset });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const user = await requireLocalWorkspaceOwner();

    assertVideoGenerationPrismaSupport();
    const { jobId } = await params;

    const job = await prisma.generationJob.findUnique({
      where: { id: jobId, userId: user.id },
      include: {
        assets: {
          where: { kind: "GENERATED" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
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

    if (job.status === "SUCCEEDED") {
      const asset = job.assets[0] ?? null;
      return succeededResponse(asset ? toAssetDTO(asset) : null);
    }

    if (job.status === "FAILED") {
      return failedResponse(job.errorMessage ?? "Video generation failed");
    }

    if (
      job.status === "RUNNING" &&
      Date.now() - job.createdAt.getTime() > VIDEO_JOB_TIMEOUT_MS
    ) {
      await prisma.generationJob.updateMany({
        where: { id: job.id, userId: user.id, status: "RUNNING" },
        data: {
          status: "FAILED",
          errorCode: "video_job_stale",
          errorMessage: "Video generation did not finish in time. Please start a new job.",
          completedAt: new Date(),
        },
      });
      return failedResponse("Video generation did not finish in time. Please start a new job.");
    }

    return runningResponse();
  } catch (error) {
    return jsonError(error);
  }
}
