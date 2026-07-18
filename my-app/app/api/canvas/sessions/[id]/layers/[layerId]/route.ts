import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/server/prisma";
import { jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { requireWritableCanvasSession } from "@/lib/server/canvas-session-access";
import {
  buildCanvasLayerUpdateData,
  canvasLayerGeometrySchema,
  canvasLayerInclude,
  canvasLayerNotFoundError,
  canvasSessionNotFoundError,
  needsFullLayerResponse,
  toLayerPayload,
} from "../../../_layer-route-helpers";

interface Params {
  params: Promise<{ id: string; layerId: string }>;
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id, layerId } = await params;
    await requireWritableCanvasSession(id, user.id);

    const sessionOwnedLayer = {
      id: layerId,
      sessionId: id,
      session: { userId: user.id },
    };

    const deleted = await prisma.canvasLayer.deleteMany({
      where: sessionOwnedLayer,
    });

    if (deleted.count !== 1) {
      const session = await prisma.canvasSession.findUnique({
        where: { id, userId: user.id },
        select: { id: true },
      });
      if (session) {
        throw canvasLayerNotFoundError();
      }
      throw canvasSessionNotFoundError();
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id, layerId } = await params;
    await requireWritableCanvasSession(id, user.id);

    const body = await parseJsonBody(request, canvasLayerGeometrySchema);

    const updated = await prisma.canvasLayer.updateMany({
      where: {
        id: layerId,
        sessionId: id,
        session: { userId: user.id },
      },
      data: buildCanvasLayerUpdateData(body),
    });

    if (updated.count !== 1) {
      const session = await prisma.canvasSession.findUnique({
        where: { id, userId: user.id },
        select: { id: true },
      });
      if (session) {
        throw canvasLayerNotFoundError();
      }
      throw canvasSessionNotFoundError();
    }

    if (!needsFullLayerResponse(body)) {
      return NextResponse.json({ ok: true });
    }

    const layer = await prisma.canvasLayer.findFirst({
      where: {
        id: layerId,
        sessionId: id,
        session: { userId: user.id },
      },
      include: canvasLayerInclude,
    });

    if (!layer) {
      throw canvasLayerNotFoundError();
    }

    return NextResponse.json({
      layer: toLayerPayload(layer),
    });
  } catch (error) {
    return jsonError(error);
  }
}
