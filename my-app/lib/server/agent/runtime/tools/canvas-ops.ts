/**
 * canvas-ops — primitive layer mutations the agent can call to arrange the
 * canvas (move / reorder / hide / show / lock). Production-grade tools intended
 * to give the agent control over composition, not just generation.
 *
 * Layer geometry changes are persisted via prisma directly; snapshot refreshes
 * are serialized by the executor so concurrent tool calls cannot race.
 */

import { tool, type Tool } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/server/prisma";
import { CANVAS_LAYER_ORDER_BY } from "@/lib/server/canvas-layer-order";
import { loadAgentLayer } from "@/lib/server/agent/runtime/layer-access";
import type { AgentToolContext } from "@/lib/server/agent/runtime/tool-registry";

export function buildMoveLayerTool(ctx: AgentToolContext): Tool {
  return tool({
    description:
      "Move and/or resize an existing canvas layer to an absolute position. All fields except layerId are optional; only provided fields change.",
    inputSchema: z.object({
      layerId: z.string().min(1),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      rotation: z.number().min(-360).max(360).optional(),
    }),
    async execute({ layerId, x, y, width, height, rotation }) {
      const startedAt = new Date().toISOString();
      const stepId = randomUUID();
      const loaded = await loadAgentLayer(ctx, layerId, { requireUnlocked: true });
      if (!loaded.ok) return { ok: false, error: loaded.error };
      const data: Record<string, number> = {};
      if (typeof x === "number") data.x = x;
      if (typeof y === "number") data.y = y;
      if (typeof width === "number") data.width = width;
      if (typeof height === "number") data.height = height;
      if (typeof rotation === "number") data.rotation = rotation;
      if (Object.keys(data).length === 0) {
        return { ok: false, error: "Provide at least one of x/y/width/height/rotation." };
      }
      await prisma.canvasLayer.update({ where: { id: layerId }, data });
      ctx.collectArtifacts({ modifiedLayerIds: [layerId] });
      await ctx.refreshSnapshot();
      ctx.recordStep({
        id: stepId,
        index: ctx.nextStepIndex(),
        toolName: "move_layer",
        category: "canvas",
        summary: `Updated geometry of ${layerId}.`,
        artifacts: { modifiedLayerIds: [layerId] },
        input: { layerId, ...data },
        output: { layerId },
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return { ok: true, layerId };
    },
  });
}

export function buildReorderLayerTool(ctx: AgentToolContext): Tool {
  return tool({
    description:
      'Change a layer\'s stacking order. direction="front" puts it on top, "back" on bottom, "forward"/"backward" moves one step.',
    inputSchema: z.object({
      layerId: z.string().min(1),
      direction: z.enum(["front", "back", "forward", "backward"]),
    }),
    async execute({ layerId, direction }) {
      const startedAt = new Date().toISOString();
      const stepId = randomUUID();
      const loaded = await loadAgentLayer(ctx, layerId, { requireUnlocked: true });
      if (!loaded.ok) return { ok: false, error: loaded.error };
      const { layer } = loaded;
      const all = await prisma.canvasLayer.findMany({
        where: { sessionId: ctx.sessionId },
        orderBy: CANVAS_LAYER_ORDER_BY,
        select: { id: true, zIndex: true },
      });
      const idx = all.findIndex((l) => l.id === layerId);
      if (idx < 0) return { ok: false, error: "Layer not found." };

      let newZ: number;
      if (direction === "front") {
        newZ = (all[all.length - 1]!.zIndex ?? 0) + 1;
      } else if (direction === "back") {
        newZ = (all[0]!.zIndex ?? 0) - 1;
      } else if (direction === "forward") {
        const next = all[idx + 1];
        if (!next) return { ok: true, layerId, note: "Already at front." };
        await prisma.$transaction([
          prisma.canvasLayer.update({ where: { id: next.id }, data: { zIndex: layer.zIndex } }),
          prisma.canvasLayer.update({ where: { id: layerId }, data: { zIndex: next.zIndex } }),
        ]);
        newZ = next.zIndex;
      } else {
        const prev = all[idx - 1];
        if (!prev) return { ok: true, layerId, note: "Already at back." };
        await prisma.$transaction([
          prisma.canvasLayer.update({ where: { id: prev.id }, data: { zIndex: layer.zIndex } }),
          prisma.canvasLayer.update({ where: { id: layerId }, data: { zIndex: prev.zIndex } }),
        ]);
        newZ = prev.zIndex;
      }
      if (direction === "front" || direction === "back") {
        await prisma.canvasLayer.update({ where: { id: layerId }, data: { zIndex: newZ } });
      }
      ctx.collectArtifacts({ modifiedLayerIds: [layerId] });
      await ctx.refreshSnapshot();
      ctx.recordStep({
        id: stepId,
        index: ctx.nextStepIndex(),
        toolName: "reorder_layer",
        category: "canvas",
        summary: `Reordered ${layerId} (${direction}).`,
        artifacts: { modifiedLayerIds: [layerId] },
        input: { layerId, direction },
        output: { layerId, zIndex: newZ },
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return { ok: true, layerId, zIndex: newZ };
    },
  });
}

export function buildSetLayerVisibilityTool(ctx: AgentToolContext): Tool {
  return tool({
    description:
      "Toggle hidden / locked flags on a layer. Use hidden=true to take a layer off-canvas without deleting it; locked=true to prevent further edits.",
    inputSchema: z.object({
      layerId: z.string().min(1),
      hidden: z.boolean().optional(),
      locked: z.boolean().optional(),
    }),
    async execute({ layerId, hidden, locked }) {
      const startedAt = new Date().toISOString();
      const stepId = randomUUID();
      const loaded = await loadAgentLayer(ctx, layerId);
      if (!loaded.ok) return { ok: false, error: loaded.error };
      const data: Record<string, boolean> = {};
      if (typeof hidden === "boolean") data.hidden = hidden;
      if (typeof locked === "boolean") data.locked = locked;
      if (Object.keys(data).length === 0) {
        return { ok: false, error: "Provide hidden and/or locked." };
      }
      if (loaded.layer.locked && locked !== false) {
        return { ok: false, error: `Layer ${layerId} is locked and cannot be changed by the agent.` };
      }
      await prisma.canvasLayer.update({ where: { id: layerId }, data });
      ctx.collectArtifacts({ modifiedLayerIds: [layerId] });
      await ctx.refreshSnapshot();
      ctx.recordStep({
        id: stepId,
        index: ctx.nextStepIndex(),
        toolName: "set_layer_visibility",
        category: "canvas",
        summary: `Updated flags of ${layerId}.`,
        artifacts: { modifiedLayerIds: [layerId] },
        input: { layerId, ...data },
        output: { layerId },
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return { ok: true, layerId };
    },
  });
}
