import "server-only";

import { prisma } from "@/lib/server/prisma";
import { isImageAssetLike } from "@/lib/server/file-validation";
import type { AgentToolContext } from "@/lib/server/agent/v2/tool-registry";

async function findAgentLayer(ctx: AgentToolContext, layerId: string) {
  return prisma.canvasLayer.findFirst({
    where: { id: layerId, session: { userId: ctx.userId } },
    select: {
      id: true,
      sessionId: true,
      assetId: true,
      x: true,
      y: true,
      width: true,
      height: true,
      zIndex: true,
      locked: true,
      asset: {
        select: {
          modality: true,
          mimeType: true,
          storagePath: true,
        },
      },
    },
  });
}

export type AgentLayer = NonNullable<Awaited<ReturnType<typeof findAgentLayer>>>;

export type AgentLayerAccessResult =
  | { ok: true; layer: AgentLayer }
  | { ok: false; error: string };

export async function loadAgentLayer(
  ctx: AgentToolContext,
  layerId: string,
  options: {
    requireImage?: boolean;
    requireUnlocked?: boolean;
    notFoundMessage?: string;
    lockedMessage?: string;
    imageRequiredMessage?: string;
  } = {},
): Promise<AgentLayerAccessResult> {
  const layer = await findAgentLayer(ctx, layerId);
  if (!layer || layer.sessionId !== ctx.sessionId) {
    return {
      ok: false,
      error: options.notFoundMessage ?? `Layer ${layerId} not found in this session.`,
    };
  }

  if (options.requireUnlocked && layer.locked) {
    return {
      ok: false,
      error: options.lockedMessage ?? `Layer ${layerId} is locked and cannot be changed by the agent.`,
    };
  }

  if (options.requireImage && !isImageAssetLike(layer.asset)) {
    return {
      ok: false,
      error: options.imageRequiredMessage ?? `Layer ${layerId} is not an image.`,
    };
  }

  return { ok: true, layer };
}
