import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/server/prisma";
import { ApiError, jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";

interface Params {
  params: Promise<{ id: string }>;
}

/** Lightweight project heartbeat used only while a generation job is active. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;
    const project = await prisma.project.findUnique({
      where: { id, userId: user.id },
      select: {
        id: true,
        jobs: {
          where: { userId: user.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 50,
          select: {
            id: true,
            status: true,
            prompt: true,
            requestedCount: true,
            successCount: true,
            createdAt: true,
          },
        },
      },
    });

    if (!project) {
      throw new ApiError({
        status: 404,
        code: "project_not_found",
        message: "Project not found.",
        retryable: false,
      });
    }

    return NextResponse.json({
      jobs: project.jobs.map((job) => ({
        ...job,
        createdAt: job.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    return jsonError(error);
  }
}
