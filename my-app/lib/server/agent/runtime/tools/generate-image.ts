/**
 * generate_image — produce N new images and add them as canvas layers.
 *
 * Wraps the existing `generateImages` server function so v2 reuses the entire
 * image-backend resolution (local sd-cpp / BYOK) without duplicating
 * code paths. Reference assets currently on canvas are auto-attached unless
 * the agent opts out.
 */

import { tool, type Tool } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/server/prisma";
import { generateImages } from "@/lib/server/image-generate";
import { resolveImageModelForGeneration } from "@/lib/server/resolve-image-model";
import { resolveGeneratedLayerSize } from "@/lib/canvas/generated-layer-size";
import { buildLayerPlacementPlan } from "@/lib/canvas/layer-placement";
import { withAssetWriteTransaction } from "@/lib/server/file-validation";
import {
  deleteStoredFile,
  writeFilesOrCleanup,
  writeGeneratedImage,
} from "@/lib/server/storage";
import {
  completeGenerationJob,
  createGenerationJob,
  failRunningGenerationJob,
} from "@/lib/server/generation-job";
import { loadImageReferenceFiles } from "@/lib/server/reference-assets";
import { assertReferenceLimit } from "@/lib/server/generate-request";
import { parseRequestedAspectRatio } from "@/lib/server/byok-shared";
import type { AgentToolContext } from "@/lib/server/agent/runtime/tool-registry";

const GRID_GAP = 24;
const GRID_ORIGIN = { x: 48, y: 48 };

export function buildGenerateImageTool(ctx: AgentToolContext): Tool {
  return tool({
    description:
      "Generate one or more new images from a text prompt and add them as new canvas layers. Reference images currently on the canvas are auto-included for image-edit-capable models unless useReferences=false.",
    inputSchema: z.object({
      prompt: z.string().min(3).describe("Refined image-generation prompt to send to the model."),
      count: z.number().int().min(1).max(4).optional().describe("How many variants (1-4)."),
      aspectRatio: z
        .string()
        .optional()
        .describe('Aspect ratio like "1:1", "16:9", "9:16". Defaults to user preference.'),
      modelId: z
        .string()
        .optional()
        .describe("Override model id. Defaults to user preference."),
      useReferences: z
        .boolean()
        .optional()
        .describe("Set false to skip auto-attaching canvas reference layers."),
    }),
    async execute({ prompt, count, aspectRatio, modelId, useReferences }) {
      const startedAt = new Date().toISOString();
      const stepId = randomUUID();
      const finalCount = count ?? ctx.uiContext.selectedCount ?? 1;
      const requestedAspect = aspectRatio || ctx.uiContext.selectedAspectRatio || "1:1";
      let finalAspect = requestedAspect;
      const finalModelId = modelId || ctx.uiContext.selectedModelId || "";
      let jobId: string | null = null;

      try {
        finalAspect = parseRequestedAspectRatio(requestedAspect) ?? "1:1";

        let referenceAssetIds: string[] = [];
        if (useReferences !== false) {
          const refLayers = await prisma.canvasLayer.findMany({
            where: { sessionId: ctx.sessionId, asset: { kind: "REFERENCE" } },
            select: { assetId: true },
          });
          referenceAssetIds = Array.from(new Set(refLayers.map((layer) => layer.assetId)));
        }
        assertReferenceLimit(0, referenceAssetIds.length);

        const references = (
          await loadImageReferenceFiles({
            assetIds: referenceAssetIds,
            userId: ctx.userId,
            invalidMessage: "Canvas references must be image assets.",
          })
        ).map((reference) => reference.bytes);

        const { model: modelEntry } = await resolveImageModelForGeneration({
          modelId: finalModelId,
          requiresEdit: references.length > 0,
        });

        const job = await createGenerationJob({
          userId: ctx.userId,
          projectId: ctx.projectId,
          source: "STUDIO",
          prompt,
          referenceCount: references.length,
          requestedCount: finalCount,
          provider: "pending",
          model: "pending",
        });
        jobId = job.id;

        const generation = await generateImages({
          prompt,
          modelId: modelEntry.id,
          count: finalCount,
          aspectRatio: finalAspect,
          references,
          isEdit: references.length > 0,
          abortSignal: ctx.abortSignal,
        });

        const storedImages = await writeFilesOrCleanup(
          generation.images.map(
            (image) => () =>
              writeGeneratedImage({
                bytes: image.bytes,
                projectId: ctx.projectId ?? undefined,
              }),
          ),
        );

        const layerSize = resolveGeneratedLayerSize(finalAspect);

        // Assets, layers and the job's terminal state all commit in ONE
        // transaction so a mid-write failure can never leave a successful asset
        // or layer attached to a FAILED job (or vice versa). On any failure the
        // transaction rolls back and we delete the orphaned files.
        const { createdAssets, createdLayers } = await withAssetWriteTransaction(async (tx) => {
          const assets = await Promise.all(
            storedImages.map((stored) =>
              tx.asset.create({
                data: {
                  userId: ctx.userId,
                  projectId: ctx.projectId,
                  jobId: job.id,
                  kind: "GENERATED",
                  storagePath: stored.storagePath,
                  mimeType: stored.mimeType,
                  byteSize: stored.byteSize,
                  width: stored.width,
                  height: stored.height,
                },
              }),
            ),
          );

          const topZ = await tx.canvasLayer.aggregate({
            where: { sessionId: ctx.sessionId },
            _max: { zIndex: true },
          });
          const placement = buildLayerPlacementPlan({
            assetIds: assets.map((a) => a.id),
            startZIndex: topZ._max.zIndex ?? -1,
            layerWidth: layerSize.width,
            layerHeight: layerSize.height,
            columns: finalCount <= 2 ? finalCount : 2,
            gridGap: GRID_GAP,
            origin: GRID_ORIGIN,
          });

          const layers = await Promise.all(
            placement.map((item) =>
              tx.canvasLayer.create({
                data: {
                  sessionId: ctx.sessionId,
                  assetId: item.assetId,
                  width: layerSize.width,
                  height: layerSize.height,
                  x: item.x,
                  y: item.y,
                  zIndex: item.zIndex,
                },
              }),
            ),
          );

          await completeGenerationJob({
            jobId: job.id,
            model: generation.model,
            provider: generation.provider,
            endpoint: generation.endpoint,
            successCount: assets.length,
            requestedCount: finalCount,
            emptyResultMessage: `${generation.provider} returned no generated images.`,
            client: tx,
          });

          return { createdAssets: assets, createdLayers: layers };
        }).catch(async (error) => {
          await Promise.allSettled(storedImages.map((s) => deleteStoredFile(s.storagePath)));
          throw error;
        });

        ctx.collectArtifacts({
          generatedAssetIds: createdAssets.map((a) => a.id),
          createdLayerIds: createdLayers.map((l) => l.id),
        });

        // Refresh snapshot so subsequent steps see the new layers.
        await ctx.refreshSnapshot();

        const summary = `Generated ${createdAssets.length} image${createdAssets.length === 1 ? "" : "s"} (${modelEntry.id}, ${finalAspect}).`;
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "generate_image",
          category: "generation",
          summary,
          artifacts: {
            generatedAssetIds: createdAssets.map((a) => a.id),
            createdLayerIds: createdLayers.map((l) => l.id),
          },
          input: { prompt, count: finalCount, aspectRatio: finalAspect, modelId: finalModelId },
          output: { layerIds: createdLayers.map((l) => l.id) },
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
        });

        return {
          ok: true,
          createdLayerIds: createdLayers.map((l) => l.id),
          assetIds: createdAssets.map((a) => a.id),
          summary,
        };
      } catch (error) {
        if (jobId) {
          await failRunningGenerationJob({ jobId, error, fallbackCode: "generation_error" });
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "generate_image",
          category: "generation",
          summary: `Image generation failed: ${message.slice(0, 200)}`,
          artifacts: {},
          input: { prompt, count: finalCount, aspectRatio: finalAspect, modelId: finalModelId },
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
