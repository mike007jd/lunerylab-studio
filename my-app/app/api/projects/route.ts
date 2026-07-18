import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/server/prisma";
import { jsonError, ApiError } from "@/lib/server/errors";
import { fetchProjects } from "@/lib/server/queries";
import { parseJsonBody } from "@/lib/server/http-validation";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { resolveLocale } from "@/lib/i18n/server";
import { getPlainT } from "@/lib/i18n/plain";
import { cloneProjectTemplate } from "@/lib/server/project-templates";
import { PROJECT_NAME_MAX_LENGTH } from "@/lib/project-name";

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH).optional(),
  templateId: z.string().min(1).optional(),
}).strict();

export async function GET(request: NextRequest) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor")?.trim() || undefined;
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);

    const page = await fetchProjects(user.id, { cursor, limit });
    return NextResponse.json(page);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireLocalWorkspaceOwner();

    const payload = await parseJsonBody(request, createProjectSchema);
    const t = getPlainT(await resolveLocale());

    const name =
      payload.name ||
      (payload.templateId
        ? ""
        : t("agent.defaultProjectName"));

    const project = payload.templateId
      ? await cloneProjectTemplate({
          userId: user.id,
          templateId: payload.templateId,
          name: payload.name,
          t,
        })
      : await prisma.project.create({
          data: { userId: user.id, name, category: "STUDIO" },
        });

    return NextResponse.json(
      {
        project: {
          id: project.id,
          name: project.name,
          category: project.category,
          createdAt: project.createdAt.toISOString(),
          updatedAt: project.updatedAt.toISOString(),
          jobCount: 0,
          assetCount: 0,
          canvasSessionCount: 0,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonError(
        new ApiError({
          status: 400,
          code: "invalid_json",
          message: "Invalid JSON payload.",
          retryable: false,
        })
      );
    }

    return jsonError(error);
  }
}
