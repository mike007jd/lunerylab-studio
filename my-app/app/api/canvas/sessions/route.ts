import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/server/prisma";
import { ApiError, jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { resolveOwnedProjectId } from "@/lib/server/project-ownership";
import {
  assetNotFoundError,
  toCanvasSessionPayload,
} from "./_session-route-helpers";

// Mirrors the prior `{ projectId?: string; title?: string; assetId?: string }`
// cast. All fields stay optional strings; the handler still does its own
// `String(... ?? "").trim()` coercion and ownership lookups below. Non-strict
// so unknown keys are ignored exactly as before.
const createCanvasSessionBodySchema = z.object({
  projectId: z.string().optional(),
  title: z.string().optional(),
  assetId: z.string().optional(),
});

function createCanvasSessionData({
  userId,
  projectId,
  title,
  selectedAssetId,
}: {
  userId: string;
  projectId: string | null;
  title: string;
  selectedAssetId: string | null;
}) {
  return {
    userId,
    projectId: projectId || undefined,
    title,
    status: "EDITING" as const,
    zoom: 1,
    panX: 0,
    panY: 0,
    selectedAssetId,
  };
}

function createInitialCanvasLayerData(
  sessionId: string,
  asset: { id: string; width: number | null; height: number | null },
) {
  if (
    typeof asset.width !== "number" ||
    typeof asset.height !== "number" ||
    !Number.isInteger(asset.width) ||
    !Number.isInteger(asset.height) ||
    asset.width <= 0 ||
    asset.height <= 0
  ) {
    throw new ApiError({
      status: 409,
      code: "asset_dimensions_missing",
      message: "This image is missing valid pixel dimensions. Import or generate it again.",
      retryable: false,
    });
  }
  return {
    sessionId,
    assetId: asset.id,
    x: 32,
    y: 32,
    width: asset.width,
    height: asset.height,
    rotation: 0,
    zIndex: 0,
  };
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireLocalWorkspaceOwner();

    const body = await parseJsonBody(request, createCanvasSessionBodySchema);

    const projectIdInput = String(body.projectId ?? "").trim();
    const assetId = String(body.assetId ?? "").trim();
    const title = String(body.title ?? "").trim() || "Canvas Session";

    const requestedProjectId = await resolveOwnedProjectId(projectIdInput, user.id);
    const requestedProject = requestedProjectId
      ? await prisma.project.findFirst({
          where: { id: requestedProjectId, userId: user.id },
          select: { isTemplate: true },
        })
      : null;

    if (requestedProject?.isTemplate) {
      throw new ApiError({
        status: 409,
        code: "template_project_read_only",
        message: "Use this template to create a project before editing it in Canvas.",
        retryable: false,
      });
    }

    const asset = assetId
      ? await prisma.asset.findFirst({
          where: {
            id: assetId,
            userId: user.id,
            modality: "IMAGE",
          },
          select: {
            id: true,
            projectId: true,
            width: true,
            height: true,
            project: { select: { userId: true, isTemplate: true } },
          },
        })
      : null;

    if (assetId && !asset) {
      throw assetNotFoundError();
    }

    if (asset?.project && asset.project.userId !== user.id) {
      throw assetNotFoundError();
    }

    if (asset?.project?.isTemplate) {
      throw new ApiError({
        status: 409,
        code: "template_asset_requires_clone",
        message: "Use this template to create a project before opening its assets in Canvas.",
        retryable: false,
      });
    }

    if (requestedProjectId && asset?.projectId && requestedProjectId !== asset.projectId) {
      throw new ApiError({
        status: 409,
        code: "asset_project_mismatch",
        message: "This asset belongs to a different project.",
        retryable: false,
      });
    }

    const effectiveProjectId = asset?.projectId ?? requestedProjectId;

    const session = await prisma.$transaction(async (tx) => {
      const createdSession = await tx.canvasSession.create({
        data: createCanvasSessionData({
          userId: user.id,
          projectId: effectiveProjectId,
          title,
          selectedAssetId: asset?.id ?? null,
        }),
      });

      if (asset) {
        await tx.canvasLayer.create({
          data: createInitialCanvasLayerData(createdSession.id, asset),
        });
      }

      return createdSession;
    });

    return NextResponse.json(
      {
        session: toCanvasSessionPayload(session),
        url: `/canvas/${session.id}`,
      },
      { status: 201 }
    );
  } catch (error) {
    return jsonError(error);
  }
}
