import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { ApiError, jsonError } from "@/lib/server/errors";
import { CANVAS_SESSION_STATUSES } from "@/lib/types/api";
import { parseJsonBody } from "@/lib/server/http-validation";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { requireWritableCanvasSession } from "@/lib/server/canvas-session-access";
import {
  parseDrawingState,
  serializeDrawingState,
} from "@/lib/canvas/drawing-state";
import {
  canvasSessionDetailInclude,
  canvasSessionNotFoundError,
  invalidStatusError,
  toCanvasSessionPayload,
} from "../_session-route-helpers";

interface Params {
  params: Promise<{ id: string }>;
}

// Mirrors the prior PATCH body cast. `status` stays a plain optional string —
// the handler keeps its own CANVAS_SESSION_STATUSES membership check and
// `invalidStatusError()` so a bad status still yields the same `invalid_status`
// error (not `invalid_body`). Numeric fields stay `z.number()` because the
// handler already gates them with `Number.isFinite`. `drawingState` is opaque
// (`z.unknown()`); `selectedAssetId` is nullish. Non-strict: extra keys ignored.
const updateCanvasSessionBodySchema = z.object({
  title: z.string().optional(),
  status: z.string().optional(),
  zoom: z.number().optional(),
  panX: z.number().optional(),
  panY: z.number().optional(),
  selectedAssetId: z.string().nullish(),
  drawingState: z.unknown().optional(),
});

function needsFullSessionResponse(body: z.infer<typeof updateCanvasSessionBodySchema>) {
  return body.title !== undefined || body.status !== undefined || body.selectedAssetId !== undefined;
}

function buildCanvasSessionUpdateData(body: {
  title?: string;
  status?: string;
  zoom?: number;
  panX?: number;
  panY?: number;
  selectedAssetId?: string | null;
  drawingState?: unknown;
}) {
  const updateData: {
    title?: string;
    status?: "EDITING" | "GENERATING" | "DONE" | "FAILED";
    zoom?: number;
    panX?: number;
    panY?: number;
    selectedAssetId?: string | null;
    drawingState?: Prisma.InputJsonValue;
  } = {};

  if (typeof body.title === "string") {
    updateData.title = body.title.trim() || "Canvas Session";
  }

  if (body.status) {
    if (!(CANVAS_SESSION_STATUSES as readonly string[]).includes(body.status)) {
      throw invalidStatusError();
    }
    updateData.status = body.status as "EDITING" | "GENERATING" | "DONE" | "FAILED";
  }

  if (typeof body.zoom === "number" && Number.isFinite(body.zoom)) {
    updateData.zoom = Math.max(0.1, Math.min(8, body.zoom));
  }

  if (typeof body.panX === "number" && Number.isFinite(body.panX)) {
    updateData.panX = body.panX;
  }

  if (typeof body.panY === "number" && Number.isFinite(body.panY)) {
    updateData.panY = body.panY;
  }

  // drawingState: store the serialized shape (freehand / text / shapes) as
  // an opaque JSON column. The runtime parser in lib/canvas/drawing-state.ts
  // handles old/missing fields when hydrating.
  if (body.drawingState !== undefined) {
    const parsed = parseDrawingState(body.drawingState);
    updateData.drawingState = serializeDrawingState(parsed) as unknown as Prisma.InputJsonValue;
  }

  return updateData;
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;

    const session = await prisma.canvasSession.findUnique({
      where: { id, userId: user.id },
      include: canvasSessionDetailInclude,
    });

    if (!session) {
      throw canvasSessionNotFoundError();
    }

    return NextResponse.json({
      session: toCanvasSessionPayload(session),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;

    // Ownership pre-check — surfaces a clean 404 instead of a silent 0-row delete.
    await requireWritableCanvasSession(id, user.id);

    // CanvasLayer.session has onDelete: Cascade in schema.prisma, so deleting
    // the session cascades layers automatically. Assets are intentionally NOT
    // deleted — they remain in the user's library.
    const deleted = await prisma.canvasSession.deleteMany({
      where: { id, userId: user.id },
    });

    if (deleted.count !== 1) {
      throw canvasSessionNotFoundError();
    }

    return NextResponse.json({ deleted: { id } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;

    const body = await parseJsonBody(request, updateCanvasSessionBodySchema);

    const updateData = buildCanvasSessionUpdateData(body);

    const existingSession = await requireWritableCanvasSession(id, user.id);

    if (body.selectedAssetId !== undefined) {
      const selectedAssetId = body.selectedAssetId ? body.selectedAssetId.trim() : null;
      if (selectedAssetId) {
        const asset = await prisma.asset.findFirst({
          where: {
            id: selectedAssetId,
            userId: user.id,
            projectId: existingSession.projectId,
          },
          select: { id: true },
        });
        if (!asset) {
          throw new ApiError({
            status: 404,
            code: "asset_not_found",
            message: "Selected asset not found.",
            retryable: false,
          });
        }
      }
      updateData.selectedAssetId = selectedAssetId;
    }

    const updated = await prisma.canvasSession.updateMany({
      where: { id, userId: user.id },
      data: updateData,
    });

    if (updated.count !== 1) {
      throw canvasSessionNotFoundError();
    }

    if (!needsFullSessionResponse(body)) {
      return NextResponse.json({ ok: true });
    }

    const session = await prisma.canvasSession.findUnique({
      where: { id, userId: user.id },
      include: canvasSessionDetailInclude,
    });

    if (!session) {
      throw canvasSessionNotFoundError();
    }

    return NextResponse.json({
      session: toCanvasSessionPayload(session),
    });
  } catch (error) {
    return jsonError(error);
  }
}
