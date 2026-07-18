import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/server/prisma";
import { jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { requireWritableCanvasSession } from "@/lib/server/canvas-session-access";
import {
  assetNotFoundError,
  assetRequiredError,
  buildCanvasLayerCreateData,
  canvasLayerGeometrySchema,
  canvasLayerInclude,
  toLayerPayload,
} from "../../_layer-route-helpers";

interface Params {
  params: Promise<{ id: string }>;
}

// Create = the shared layer geometry schema + `assetId`. The handler keeps its
// own `assetRequiredError()` check plus the per-field guards in
// buildCanvasLayerCreateData.
const createCanvasLayerBodySchema = canvasLayerGeometrySchema.extend({
  assetId: z.string().optional(),
});

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;

    const body = await parseJsonBody(request, createCanvasLayerBodySchema);

    const assetId = String(body.assetId ?? "").trim();
    if (!assetId) {
      throw assetRequiredError();
    }

    // Validate session ownership BEFORE the asset lookup. The previous order
    // let an attacker probe whether `assetId` belonged to the user even for a
    // session they did not own (the asset query filters by `userId` too, but
    // the existence response leaks). Gate on session first; only then look up
    // the asset scoped to that session's project.
    const session = await requireWritableCanvasSession(id, user.id);

    const asset = await prisma.asset.findFirst({
      where: {
        id: assetId,
        userId: user.id,
        projectId: session.projectId ?? null,
      },
      select: { id: true },
    });
    if (!asset) {
      throw assetNotFoundError();
    }

    const layer = await prisma.canvasLayer.create({
      data: buildCanvasLayerCreateData(id, assetId, body),
      include: canvasLayerInclude,
    });

    return NextResponse.json(
      {
        layer: toLayerPayload(layer),
      },
      { status: 201 }
    );
  } catch (error) {
    return jsonError(error);
  }
}
