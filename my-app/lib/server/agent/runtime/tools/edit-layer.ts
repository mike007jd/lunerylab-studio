/**
 * edit_layer — replace the content of a layer (optionally only inside a
 * user-marked region), then add the result as a new layer on top while
 * hiding the original. Reuses the v1 image-edit composition path.
 */

import { tool, type Tool } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generateImages } from "@/lib/server/image-generate";
import { resolveImageModelForGeneration } from "@/lib/server/resolve-image-model";
import {
  cropRegion,
  compositeBack,
  type ComposeRect,
} from "@/lib/server/image-compose";
import { readStoredFile } from "@/lib/server/storage";
import {
  completeGenerationJob,
  createGenerationJob,
  failRunningGenerationJob,
} from "@/lib/server/generation-job";
import { loadAgentLayer } from "@/lib/server/agent/runtime/layer-access";
import { saveResultAsReplacementLayer } from "@/lib/server/agent/runtime/replacement-layer";
import type { AgentToolContext } from "@/lib/server/agent/runtime/tool-registry";

export function buildEditLayerTool(ctx: AgentToolContext): Tool {
  return tool({
    description:
      "Replace content of an existing canvas layer using an image-edit-capable model. If the user marked a region (see ctx), only that region is replaced and composited back. The original layer is hidden, the result is added on top.",
    inputSchema: z.object({
      layerId: z.string().min(1).describe("Target canvas layer id to edit."),
      prompt: z.string().min(3).describe("What the layer (or the marked region) should become."),
      modelId: z.string().optional().describe("Override edit-capable model id."),
    }),
    async execute({ layerId, prompt, modelId }) {
      const startedAt = new Date().toISOString();
      const stepId = randomUUID();
      let jobId: string | null = null;

      try {
        const loaded = await loadAgentLayer(ctx, layerId, {
          requireImage: true,
          requireUnlocked: true,
          lockedMessage: `Layer ${layerId} is locked and cannot be edited by the agent.`,
          imageRequiredMessage: `Layer ${layerId} is not an image and cannot be edited.`,
        });
        if (!loaded.ok) return { ok: false, error: loaded.error };
        const { layer } = loaded;

        const { model: modelEntry } = await resolveImageModelForGeneration({
          modelId: modelId || ctx.uiContext.selectedModelId || "",
          requiresEdit: true,
        });

        const job = await createGenerationJob({
          userId: ctx.userId,
          projectId: ctx.projectId,
          source: "STUDIO",
          toolType: "edit",
          prompt,
          referenceCount: 1,
          requestedCount: 1,
          provider: "pending",
          model: "pending",
        });
        jobId = job.id;

        const stored = await readStoredFile(layer.asset.storagePath);
        const sourceBuffer = Buffer.from(stored.file);
        const region = ctx.region;

        let composeRect: ComposeRect | null = null;
        let editInput: Buffer = sourceBuffer;
        if (region) {
          const cropped = await cropRegion(
            sourceBuffer,
            region.bbox,
            layer.width,
            layer.height,
          );
          editInput = cropped.cropBuffer;
          composeRect = cropped.rect;
        }

        const generation = await generateImages({
          prompt: region
            ? `Replace the content of this image region with: ${prompt}. Keep style, lighting and edges consistent so it blends naturally.`
            : prompt,
          modelId: modelEntry.id,
          count: 1,
          references: [editInput],
          isEdit: true,
          abortSignal: ctx.abortSignal,
        });

        const editedBytes = Buffer.from(generation.images[0]!.bytes);
        const finalBytes =
          composeRect !== null
            ? await compositeBack(sourceBuffer, editedBytes, composeRect)
            : editedBytes;

        const { assetId: createdAssetId, layerId: createdLayerId } =
          await saveResultAsReplacementLayer(
            ctx,
            {
              id: layer.id,
              x: layer.x,
              y: layer.y,
              width: layer.width,
              height: layer.height,
            },
            finalBytes,
            job.id,
          );

        await completeGenerationJob({
          jobId,
          model: generation.model,
          provider: generation.provider,
          successCount: 1,
          requestedCount: 1,
        });

        ctx.collectArtifacts({
          generatedAssetIds: [createdAssetId],
          createdLayerIds: [createdLayerId],
          modifiedLayerIds: [layer.id],
        });

        await ctx.refreshSnapshot();

        const summary = region
          ? `Replaced marked region of layer ${layer.id}.`
          : `Replaced layer ${layer.id} with new version.`;
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "edit_layer",
          category: "generation",
          summary,
          artifacts: {
            generatedAssetIds: [createdAssetId],
            createdLayerIds: [createdLayerId],
            modifiedLayerIds: [layer.id],
          },
          input: { layerId, prompt, modelId: modelEntry.id, region: Boolean(region) },
          output: { newLayerId: createdLayerId },
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
        });

        return {
          ok: true,
          newLayerId: createdLayerId,
          hiddenLayerId: layer.id,
          summary,
        };
      } catch (error) {
        if (jobId) {
          await failRunningGenerationJob({ jobId, error, fallbackCode: "edit_error" });
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "edit_layer",
          category: "generation",
          summary: `Edit failed: ${message.slice(0, 200)}`,
          artifacts: {},
          input: { layerId, prompt },
          status: "failed",
          startedAt,
          completedAt: new Date().toISOString(),
          errorMessage: message,
        });
        return { ok: false, error: message.slice(0, 400) };
      }
    },
  });
}
