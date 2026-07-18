/**
 * POST /api/canvas/sessions/[id]/snapshots/[snapId]/restore
 *
 * Restores a snapshot into the active session:
 *   1. Captures a fresh "Before restore" auto-snapshot so the restore itself
 *      is undoable.
 *   2. Replaces drawingState with the snapshot's drawingState.
 *   3. Reconciles layers: existing layers are updated to the snapshot's
 *      geometry; layers in the snapshot that no longer exist are skipped;
 *      layers currently on canvas but absent from the snapshot are hidden
 *      (not deleted — assets stay safe in Library).
 */

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { ApiError, jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { requireWritableCanvasSession } from "@/lib/server/canvas-session-access";
import { saveCanvasSnapshot } from "@/lib/server/canvas-snapshot";
import {
  parseDrawingState,
  serializeDrawingState,
} from "@/lib/canvas/drawing-state";

interface Params {
  params: Promise<{ id: string; snapId: string }>;
}

interface SnapshotLayer {
  id: string;
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  locked: boolean;
  hidden: boolean;
}

interface SnapshotData {
  layers: SnapshotLayer[];
  drawingState: unknown;
}

function joinSqlFragments(fragments: Prisma.Sql[]) {
  return fragments.reduce((acc, fragment) => Prisma.sql`${acc} ${fragment}`, Prisma.empty);
}

function layerCase<T extends keyof SnapshotLayer>(layers: SnapshotLayer[], field: T) {
  return joinSqlFragments(
    layers.map((layer) => Prisma.sql`WHEN ${layer.id} THEN ${layer[field]}`),
  );
}

export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id, snapId } = await params;

    await requireWritableCanvasSession(id, user.id);
    const snapshot = await prisma.canvasSnapshot.findUnique({ where: { id: snapId } });
    if (!snapshot || snapshot.sessionId !== id) {
      throw new ApiError({
        status: 404,
        code: "snapshot_not_found",
        message: "Snapshot not found.",
        retryable: false,
      });
    }

    const data = snapshot.data as unknown as SnapshotData;
    const drawingState = serializeDrawingState(parseDrawingState(data.drawingState));

    await saveCanvasSnapshot({
      sessionId: id,
      label: `Before restore of ${snapshot.label}`,
      isAutomatic: true,
    });

    await prisma.$transaction(async (tx) => {
      // Apply snapshot layers — update existing, hide layers absent from snapshot.
      const snapLayerIds = data.layers.map((layer) => layer.id);
      if (data.layers.length > 0) {
        await tx.$executeRaw(
          Prisma.sql`
            UPDATE "CanvasLayer"
            SET
              "x" = CASE "id" ${layerCase(data.layers, "x")} ELSE "x" END,
              "y" = CASE "id" ${layerCase(data.layers, "y")} ELSE "y" END,
              "width" = CASE "id" ${layerCase(data.layers, "width")} ELSE "width" END,
              "height" = CASE "id" ${layerCase(data.layers, "height")} ELSE "height" END,
              "rotation" = CASE "id" ${layerCase(data.layers, "rotation")} ELSE "rotation" END,
              "zIndex" = CASE "id" ${layerCase(data.layers, "zIndex")} ELSE "zIndex" END,
              "locked" = CASE "id" ${layerCase(data.layers, "locked")} ELSE "locked" END,
              "hidden" = CASE "id" ${layerCase(data.layers, "hidden")} ELSE "hidden" END
            WHERE "sessionId" = ${id} AND "id" IN (${Prisma.join(snapLayerIds)})
          `,
        );
      }
      await tx.canvasLayer.updateMany({
        where: { sessionId: id, id: { notIn: snapLayerIds } },
        data: { hidden: true },
      });

      // Replace drawing state.
      await tx.canvasSession.update({
        where: { id },
        data: { drawingState: drawingState as unknown as Prisma.InputJsonValue },
      });
    });

    return NextResponse.json({ ok: true, restoredFromSnapshotId: snapId });
  } catch (error) {
    return jsonError(error);
  }
}
