/**
 * Canvas snapshot helper — captures the current layer geometry + drawing
 * state of a session and writes a CanvasSnapshot row.
 *
 * Used by:
 *   - Agent runtime executor (auto-snapshot after a successful run that mutated
 *     the canvas), so multi-step agent runs are trivially reversible.
 *   - Manual snapshot creation via POST /api/canvas/sessions/[id]/snapshots.
 */

import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { CANVAS_LAYER_ORDER_BY } from "@/lib/server/canvas-layer-order";
import {
  parseDrawingState,
  serializeDrawingState,
} from "@/lib/canvas/drawing-state";

const MAX_SNAPSHOTS_PER_SESSION = 50;

export interface SaveCanvasSnapshotInput {
  sessionId: string;
  label: string;
  isAutomatic?: boolean;
}

export interface SavedSnapshot {
  id: string;
  label: string;
  isAutomatic: boolean;
  createdAt: string;
}

/**
 * Capture and persist a snapshot. Safe to call from a fire-and-forget
 * context — returns `null` and swallows errors when the session does not
 * exist (e.g. it was deleted between agent steps).
 */
export async function saveCanvasSnapshot(
  input: SaveCanvasSnapshotInput,
): Promise<SavedSnapshot | null> {
  const session = await prisma.canvasSession.findUnique({
    where: { id: input.sessionId },
    select: { id: true, drawingState: true },
  });
  if (!session) return null;

  const layers = await prisma.canvasLayer.findMany({
    where: { sessionId: input.sessionId },
    orderBy: CANVAS_LAYER_ORDER_BY,
  });

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
    drawingState: serializeDrawingState(parseDrawingState(session.drawingState)),
  };

  // Prune-then-create runs inside a single transaction so two concurrent
  // saves cannot both pass the cap check. Only AUTOMATIC snapshots are ever
  // pruned (oldest first): a manual snapshot is a deliberate user checkpoint
  // and must never be destroyed by a background auto-snapshot. This matches the
  // manual POST route's invariant — the only difference is the terminal:
  // the manual route 409s when the cap is full of manuals; this fire-and-forget
  // path simply skips (returns null) so an agent run can't silently delete the
  // user's saved checkpoints to make room for its own auto-snapshot.
  const created = await prisma.$transaction(async (tx) => {
    const count = await tx.canvasSnapshot.count({
      where: { sessionId: input.sessionId },
    });
    if (count >= MAX_SNAPSHOTS_PER_SESSION) {
      const overflow = await tx.canvasSnapshot.findMany({
        where: { sessionId: input.sessionId, isAutomatic: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: count - MAX_SNAPSHOTS_PER_SESSION + 1,
        select: { id: true },
      });
      if (overflow.length > 0) {
        await tx.canvasSnapshot.deleteMany({
          where: { id: { in: overflow.map((s) => s.id) } },
        });
      }
      // Post-prune total = pre-count minus what we just deleted (exact inside
      // the transaction — no extra round-trip). Session is full of manual
      // snapshots → skip rather than evict one.
      if (count - overflow.length >= MAX_SNAPSHOTS_PER_SESSION) return null;
    }
    return tx.canvasSnapshot.create({
      data: {
        sessionId: input.sessionId,
        label: input.label.trim().slice(0, 120) || "Snapshot",
        isAutomatic: Boolean(input.isAutomatic),
        data: data as unknown as Prisma.InputJsonValue,
      },
    });
  });

  if (!created) return null;

  return {
    id: created.id,
    label: created.label,
    isAutomatic: created.isAutomatic,
    createdAt: created.createdAt.toISOString(),
  };
}
