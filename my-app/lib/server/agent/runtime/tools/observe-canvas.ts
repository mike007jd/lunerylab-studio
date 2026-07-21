/**
 * observe_canvas — refresh the agent's view of the canvas at any step.
 *
 * The system prompt already includes the initial snapshot; this tool lets the
 * agent pull a fresh one after generation / edit steps that mutate the canvas.
 */

import { tool, type Tool } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CANVAS_SNAPSHOT_LAYER_LIMIT,
  projectCanvasSnapshot,
} from "@/lib/server/agent/runtime/canvas-serializer";
import type { AgentToolContext } from "@/lib/server/agent/runtime/tool-registry";

export function buildObserveCanvasTool(ctx: AgentToolContext): Tool {
  return tool({
    description:
      "Refresh and return a bounded current-canvas view. Use layerId to force one exact layer into the summary, or startIndex/limit to page deterministically through every layer. Call this before acting when the target is not visible in the current summary.",
    inputSchema: z
      .object({
        layerId: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .optional()
          .describe("Exact layer id to include in the prioritized canvas summary."),
        startIndex: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Back-to-front layer offset for deterministic paging."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(CANVAS_SNAPSHOT_LAYER_LIMIT)
          .optional()
          .describe(`Page size, at most ${CANVAS_SNAPSHOT_LAYER_LIMIT}.`),
      })
      .refine((input) => !(input.layerId && input.startIndex !== undefined), {
        message: "Use either layerId focus or startIndex paging, not both.",
      }),
    async execute({ layerId, startIndex, limit }) {
      const startedAt = new Date().toISOString();
      const stepId = randomUUID();
      await ctx.refreshSnapshot();

      const projection = projectCanvasSnapshot(ctx.snapshot, {
        focusLayerId: layerId,
        startIndex,
        layerLimit: limit,
      });
      ctx.recordStep({
        id: stepId,
        index: ctx.nextStepIndex(),
        toolName: "observe_canvas",
        category: "observe",
        summary: `Refreshed canvas (${ctx.snapshot.layerCount} layer${ctx.snapshot.layerCount === 1 ? "" : "s"}).`,
        artifacts: {},
        input: { layerId, startIndex, limit },
        output: {
          layerCount: ctx.snapshot.layerCount,
          includedLayerCount: projection.includedLayerCount,
          omittedLayerCount: projection.omittedLayerCount,
          nextStartIndex: projection.nextStartIndex,
        },
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
      });

      return {
        ok: true,
        canvas: projection.text,
        layerCount: ctx.snapshot.layerCount,
        includedLayerCount: projection.includedLayerCount,
        omittedLayerCount: projection.omittedLayerCount,
        nextStartIndex: projection.nextStartIndex,
        focusedLayerFound: projection.focusedLayerFound,
      };
    },
  });
}
