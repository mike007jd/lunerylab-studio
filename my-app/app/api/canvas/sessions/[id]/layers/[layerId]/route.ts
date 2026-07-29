import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/server/prisma";
import { jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { requireWritableCanvasSession } from "@/lib/server/canvas-session-access";
import {
  assertCanvasLayerWriteApplied,
  buildCanvasLayerUpdateData,
  canvasLayerGeometrySchema,
  canvasLayerInclude,
  canvasLayerNotFoundError,
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
      where: {
        ...sessionOwnedLayer,
        locked: false,
      },
    });

    await assertCanvasLayerWriteApplied({
      affectedCount: deleted.count,
      layerWhere: sessionOwnedLayer,
      sessionId: id,
      userId: user.id,
    });

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
    const data = buildCanvasLayerUpdateData(body);
    const sessionOwnedLayer = {
      id: layerId,
      sessionId: id,
      session: { userId: user.id },
    };

    const updated = await prisma.canvasLayer.updateMany({
      where: {
        ...sessionOwnedLayer,
        // An explicit unlock may cross the lock boundary. Every other update
        // atomically requires the database row to still be unlocked so a stale
        // client cannot race a newly-arrived agent lock.
        ...(body.locked === false ? {} : { locked: false }),
      },
      data,
    });

    await assertCanvasLayerWriteApplied({
      affectedCount: updated.count,
      layerWhere: sessionOwnedLayer,
      sessionId: id,
      userId: user.id,
    });

    if (!needsFullLayerResponse(body)) {
      return NextResponse.json({ ok: true });
    }

    const layer = await prisma.canvasLayer.findFirst({
      where: sessionOwnedLayer,
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
