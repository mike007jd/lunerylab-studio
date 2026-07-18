import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/server/prisma";
import { ApiError, jsonError, withPrismaNotFound } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { fetchProjectActivity } from "@/lib/server/queries";
import { PROJECT_NAME_MAX_LENGTH } from "@/lib/project-name";

const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH),
}).strict();

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;
    const url = new URL(request.url);
    const sectionParam = url.searchParams.get("section");
    const section = sectionParam === "jobs" || sectionParam === "canvasSessions"
      ? sectionParam
      : "all";
    const activity = await fetchProjectActivity(user.id, id, {
      section,
      jobsCursor: url.searchParams.get("jobsCursor")?.trim() || undefined,
      canvasSessionsCursor:
        url.searchParams.get("canvasSessionsCursor")?.trim() || undefined,
    });

    if (!activity) {
      throw new ApiError({
        status: 404,
        code: "project_not_found",
        message: "Project not found.",
        retryable: false,
      });
    }

    return NextResponse.json(activity);
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;
    const body = await parseJsonBody(request, updateProjectSchema);

    // Single round-trip: `update({ where: { id, userId } })` raises P2025 if
    // the row doesn't match, which we translate to 404. Avoids the
    // updateMany → findUnique race where a concurrent delete could flip the
    // outcome between the two queries.
    const project = await withPrismaNotFound(
      prisma.project.update({
        where: { id, userId: user.id, isTemplate: false },
        data: { name: body.name },
        select: { id: true, name: true, updatedAt: true },
      }),
      "Project not found.",
    );

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;

    const existing = await prisma.project.findUnique({
      where: { id, userId: user.id },
      select: { id: true, name: true, isTemplate: true },
    });

    if (!existing) {
      throw new ApiError({
        status: 404,
        code: "project_not_found",
        message: "Project not found.",
        retryable: false,
      });
    }
    if (existing.isTemplate) {
      throw new ApiError({
        status: 403,
        code: "template_read_only",
        message: "Templates are read-only.",
        retryable: false,
      });
    }

    const deleted = await prisma.$transaction(async (tx) => {
      await tx.asset.updateMany({
        where: { projectId: id, userId: user.id },
        data: { projectId: null },
      });
      await tx.generationJob.updateMany({
        where: { projectId: id, userId: user.id },
        data: { projectId: null },
      });
      await tx.canvasSession.updateMany({
        where: { projectId: id, userId: user.id },
        data: { projectId: null },
      });
      return tx.project.deleteMany({
        where: { id, userId: user.id },
      });
    });

    if (deleted.count !== 1) {
      throw new ApiError({
        status: 404,
        code: "project_not_found",
        message: "Project not found.",
        retryable: false,
      });
    }

    return NextResponse.json({
      deleted: {
        id: existing.id,
        name: existing.name,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
