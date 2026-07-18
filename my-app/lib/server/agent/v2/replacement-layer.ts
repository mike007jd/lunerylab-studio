/**
 * Shared "non-destructive replacement" persistence for agent edit tools.
 *
 * Agent edit invariant #4: edits never destroy the original. The result is
 * written as a NEW asset + a NEW top-z canvas layer while the source layer is
 * hidden. This skeleton (write file → quota-checked asset create with rollback →
 * hide original + create top-z layer with rollback) used to be implemented
 * twice — once here for inpaint/background-remove (image-edit.ts) and once,
 * minus the layer-create rollback, in edit-layer.ts. Centralising it keeps the
 * z-order / hide semantics in one place and gives every caller the same
 * orphaned-asset cleanup on a mid-write failure.
 */

import "server-only";
import { prisma } from "@/lib/server/prisma";
import { withUserStorageQuota } from "@/lib/server/file-validation";
import { deleteStoredFile, writeGeneratedImage } from "@/lib/server/storage";
import type { AgentToolContext } from "@/lib/server/agent/v2/tool-registry";

export interface ReplacementSourceLayer {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function saveResultAsReplacementLayer(
  ctx: AgentToolContext,
  sourceLayer: ReplacementSourceLayer,
  finalBytes: Buffer,
  jobId: string,
): Promise<{ assetId: string; layerId: string }> {
  const stored = await writeGeneratedImage({
    bytes: finalBytes,
    projectId: ctx.projectId ?? undefined,
  });
  const createdAsset = await withUserStorageQuota(ctx.userId, stored.byteSize, (tx) =>
    tx.asset.create({
      data: {
        userId: ctx.userId,
        projectId: ctx.projectId,
        jobId,
        kind: "GENERATED",
        modality: "IMAGE",
        storagePath: stored.storagePath,
        mimeType: stored.mimeType,
        byteSize: stored.byteSize,
        width: stored.width,
        height: stored.height,
      },
    }),
  ).catch(async (error) => {
    await deleteStoredFile(stored.storagePath);
    throw error;
  });

  let createdLayer: { id: string };
  try {
    // Atomic: hide-original + top-z lookup + create-replacement must commit or
    // roll back together. Without the transaction a failure after the `hidden:
    // true` update left the source layer permanently invisible — the edit
    // failed yet the user's canvas content vanished. On rollback the source
    // stays visible; the new asset/file (created outside this tx) are cleaned
    // up in the catch.
    createdLayer = await prisma.$transaction(async (tx) => {
      await tx.canvasLayer.update({
        where: { id: sourceLayer.id },
        data: { hidden: true },
      });
      const topZ = await tx.canvasLayer.aggregate({
        where: { sessionId: ctx.sessionId },
        _max: { zIndex: true },
      });
      return tx.canvasLayer.create({
        data: {
          sessionId: ctx.sessionId,
          assetId: createdAsset.id,
          width: sourceLayer.width,
          height: sourceLayer.height,
          x: sourceLayer.x,
          y: sourceLayer.y,
          zIndex: (topZ._max.zIndex ?? 0) + 1,
        },
        select: { id: true },
      });
    });
  } catch (error) {
    await prisma.asset.deleteMany({ where: { id: createdAsset.id, userId: ctx.userId } }).catch(() => undefined);
    await deleteStoredFile(stored.storagePath);
    throw error;
  }
  return { assetId: createdAsset.id, layerId: createdLayer.id };
}
