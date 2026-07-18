import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { ApiError } from "@/lib/server/errors";
import { saveCanvasSnapshot } from "@/lib/server/canvas-snapshot";
import { parseDrawingState, serializeDrawingState } from "@/lib/canvas/drawing-state";

interface SnapshotLayer {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  locked: boolean;
  hidden: boolean;
}

function joinSqlFragments(fragments: Prisma.Sql[]) {
  return fragments.reduce((acc, fragment) => Prisma.sql`${acc} ${fragment}`, Prisma.empty);
}

function layerCase<T extends keyof SnapshotLayer>(layers: SnapshotLayer[], field: T) {
  return joinSqlFragments(layers.map((layer) => Prisma.sql`WHEN ${layer.id} THEN ${layer[field]}`));
}

export async function undoAgentTask({
  taskId,
  sessionId,
  userId,
}: {
  taskId: string;
  sessionId: string;
  userId: string;
}): Promise<void> {
  const task = await prisma.agentTask.findFirst({
    where: { id: taskId, sessionId, userId },
    select: { id: true, status: true, beforeSnapshot: { select: { id: true, label: true, data: true } } },
  });
  if (!task?.beforeSnapshot) {
    throw new ApiError({ status: 404, code: "task_undo_unavailable", message: "This task cannot be undone.", retryable: false });
  }
  if (task.status === "UNDONE") return;

  const data = task.beforeSnapshot.data as unknown as { layers: SnapshotLayer[]; drawingState: unknown };
  const drawingState = serializeDrawingState(parseDrawingState(data.drawingState));
  await saveCanvasSnapshot({ sessionId, label: `Before undo of ${task.beforeSnapshot.label}`, isAutomatic: true });

  await prisma.$transaction(async (tx) => {
    const layerIds = data.layers.map((layer) => layer.id);
    if (data.layers.length > 0) {
      await tx.$executeRaw(Prisma.sql`
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
        WHERE "sessionId" = ${sessionId} AND "id" IN (${Prisma.join(layerIds)})
      `);
    }
    await tx.canvasLayer.updateMany({
      where: { sessionId, id: { notIn: layerIds } },
      data: { hidden: true },
    });
    await tx.canvasSession.update({
      where: { id: sessionId, userId },
      data: { drawingState: drawingState as unknown as Prisma.InputJsonValue },
    });
    await tx.agentTask.update({ where: { id: taskId }, data: { status: "UNDONE" } });
  });
}
