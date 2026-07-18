/**
 * Canvas session snapshots — list + create.
 *
 * A snapshot captures the layer geometry + drawingState at a point in time so
 * the user (or the agent) can roll back / branch from it. Heavy bodies live
 * in `data` (Json); the list endpoint omits `data` to keep responses small.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/server/prisma";
import { ApiError, jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { requireWritableCanvasSession } from "@/lib/server/canvas-session-access";
import {
  parseDrawingState,
  serializeDrawingState,
} from "@/lib/canvas/drawing-state";
import { CANVAS_LAYER_ORDER_BY } from "@/lib/server/canvas-layer-order";

interface Params {
  params: Promise<{ id: string }>;
}

const MAX_SNAPSHOTS_PER_SESSION = 50;

// Mirrors the prior `{ label?: string; isAutomatic?: boolean; drawingState?: unknown } | null`
// cast. The route tolerated a null body (uses `body?.label`,
// `Boolean(body?.isAutomatic)`, `body?.drawingState !== undefined`) so the
// object is `.nullable()`. The handler keeps its own trim/slice/default and
// drawingState normalization. Non-strict: extra keys ignored. This only
// newly-rejects a structurally non-object/non-null body as `invalid_body`.
const createSnapshotBodySchema = z
  .object({
    label: z.string().optional(),
    isAutomatic: z.boolean().optional(),
    drawingState: z.unknown().optional(),
  })
  .nullable();

async function assertOwnedSession(sessionId: string, userId: string): Promise<void> {
  const session = await prisma.canvasSession.findUnique({
    where: { id: sessionId, userId },
    select: { id: true },
  });
  if (!session) {
    throw new ApiError({
      status: 404,
      code: "canvas_session_not_found",
      message: "Canvas session not found.",
      retryable: false,
    });
  }
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;
    await assertOwnedSession(id, user.id);
    const rows = await prisma.canvasSnapshot.findMany({
      where: { sessionId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_SNAPSHOTS_PER_SESSION,
      select: {
        id: true,
        label: true,
        isAutomatic: true,
        createdAt: true,
      },
    });
    return NextResponse.json({
      snapshots: rows.map((row) => ({
        id: row.id,
        label: row.label,
        isAutomatic: row.isAutomatic,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;
    await requireWritableCanvasSession(id, user.id);

    const body = await parseJsonBody(request, createSnapshotBodySchema);
    const rawLabel = typeof body?.label === "string" ? body.label.trim() : "";
    const label = rawLabel.length > 0 ? rawLabel.slice(0, 120) : `Snapshot ${new Date().toLocaleString()}`;
    const isAutomatic = Boolean(body?.isAutomatic);

    // Capture the current layer geometry + the supplied drawingState (or the
    // last persisted one). Layers are the authoritative source of asset slots
    // so we snapshot them at write time rather than trusting a client payload.
    const [layers, session] = await Promise.all([
      prisma.canvasLayer.findMany({
        where: { sessionId: id },
        orderBy: CANVAS_LAYER_ORDER_BY,
      }),
      prisma.canvasSession.findUnique({
        where: { id, userId: user.id },
        select: { drawingState: true },
      }),
    ]);

    const drawingState =
      body?.drawingState !== undefined
        ? serializeDrawingState(parseDrawingState(body.drawingState))
        : serializeDrawingState(parseDrawingState(session?.drawingState));

    const data = {
      layers: layers.map((layer) => ({
        id: layer.id,
        assetId: layer.assetId,
        x: layer.x,
        y: layer.y,
        width: layer.width,
        height: layer.height,
        rotation: layer.rotation,
        zIndex: layer.zIndex,
        locked: layer.locked,
        hidden: layer.hidden,
      })),
      drawingState,
    };

    // Prune-then-create runs inside a single transaction so two concurrent
    // saves cannot both pass the cap check and push the snapshot count above
    // MAX_SNAPSHOTS_PER_SESSION. Manual snapshots get priority — automatic
    // ones are pruned first; only when no automatic remains do we 409.
    const created = await prisma.$transaction(async (tx) => {
      const count = await tx.canvasSnapshot.count({ where: { sessionId: id } });
      if (count >= MAX_SNAPSHOTS_PER_SESSION) {
        const overflow = await tx.canvasSnapshot.findMany({
          where: { sessionId: id, isAutomatic: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: count - MAX_SNAPSHOTS_PER_SESSION + 1,
          select: { id: true },
        });
        if (overflow.length > 0) {
          await tx.canvasSnapshot.deleteMany({
            where: { id: { in: overflow.map((s) => s.id) } },
          });
        }
        const remaining = await tx.canvasSnapshot.count({ where: { sessionId: id } });
        if (remaining >= MAX_SNAPSHOTS_PER_SESSION) {
          throw new ApiError({
            status: 409,
            code: "snapshot_limit_reached",
            message: "Snapshot limit reached for this canvas session.",
            retryable: false,
          });
        }
      }
      return tx.canvasSnapshot.create({
        data: {
          sessionId: id,
          label,
          isAutomatic,
          data: data as unknown as import("@prisma/client").Prisma.InputJsonValue,
        },
      });
    });

    return NextResponse.json(
      {
        snapshot: {
          id: created.id,
          label: created.label,
          isAutomatic: created.isAutomatic,
          createdAt: created.createdAt.toISOString(),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
