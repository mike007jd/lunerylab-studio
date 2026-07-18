/**
 * export_layer_for_platforms — produce platform-sized exports from a canvas
 * layer's source asset and save them as new GENERATED assets attached to the
 * project. Agent uses this to satisfy "give me IG square + IG story + TikTok"
 * requests in one shot.
 */

import { tool, type Tool } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  deleteStoredFile,
  readStoredFile,
  writeFilesOrCleanup,
  writeGeneratedImage,
} from "@/lib/server/storage";
import { withUserStorageQuota } from "@/lib/server/file-validation";
import {
  completeGenerationJob,
  createGenerationJob,
  failRunningGenerationJob,
} from "@/lib/server/generation-job";
import { exportForPlatforms } from "@/lib/server/platform-export";
import {
  PLATFORM_SIZES_BY_ID,
} from "@/lib/constants/platform-sizes";
import { loadAgentLayer } from "@/lib/server/agent/v2/layer-access";
import type { AgentToolContext } from "@/lib/server/agent/v2/tool-registry";

export function buildExportPlatformsTool(ctx: AgentToolContext): Tool {
  return tool({
    description:
      "Resize a canvas layer's source image into one or more platform-sized exports (IG Post, IG Story, TikTok Vertical, Pinterest, YouTube Thumbnail, OG image, etc.) and save each as a new asset attached to the project. Use after the user asks for platform deliverables.",
    inputSchema: z.object({
      layerId: z.string().min(1).describe("Source canvas layer to export from."),
      presetIds: z
        .array(z.string())
        .min(1)
        .max(12)
        .describe("Platform preset ids (e.g. ig-post-square, ig-story, tiktok-reel, og-image)."),
      fit: z
        .enum(["cover", "contain"])
        .optional()
        .describe("cover = crop to fill (default), contain = letterbox to fit."),
    }),
    async execute({ layerId, presetIds, fit }) {
      const startedAt = new Date().toISOString();
      const stepId = randomUUID();
      let jobId: string | null = null;

      const invalid = presetIds.filter((id) => !PLATFORM_SIZES_BY_ID[id]);
      if (invalid.length > 0) {
        return {
          ok: false,
          error: `Unknown platform preset(s): ${invalid.join(", ")}.`,
        };
      }

      try {
        const loaded = await loadAgentLayer(ctx, layerId, {
          requireImage: true,
          imageRequiredMessage: `Layer ${layerId} is not an image and cannot be exported as platform artwork.`,
        });
        if (!loaded.ok) return { ok: false, error: loaded.error };
        const { layer } = loaded;

        const stored = await readStoredFile(layer.asset.storagePath);
        const source = Buffer.from(stored.file);

        const job = await createGenerationJob({
          userId: ctx.userId,
          projectId: ctx.projectId,
          source: "STUDIO",
          toolType: "extender",
          prompt: `Platform export: ${presetIds.join(", ")}`,
          referenceCount: 1,
          requestedCount: presetIds.length,
          provider: "platform-export",
          model: "sharp",
        });
        jobId = job.id;

        const exports = await exportForPlatforms(source, presetIds, { fit: fit ?? "cover" });

        const storedExports = await writeFilesOrCleanup(
          exports.map(
            (exp) => () =>
              writeGeneratedImage({
                bytes: exp.bytes,
                projectId: ctx.projectId ?? undefined,
              }),
          ),
        );

        // Assets + job terminal state commit atomically; files are deleted if
        // the transaction rolls back.
        const createdAssets = await withUserStorageQuota(
          ctx.userId,
          storedExports.reduce((sum, s) => sum + s.byteSize, 0),
          async (tx) => {
            const assets = await Promise.all(
              storedExports.map((stored) =>
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
            await completeGenerationJob({
              jobId: job.id,
              model: "sharp",
              provider: "platform-export",
              successCount: assets.length,
              requestedCount: presetIds.length,
              client: tx,
            });
            return assets;
          },
        ).catch(async (error) => {
          await Promise.allSettled(storedExports.map((stored) => deleteStoredFile(stored.storagePath)));
          throw error;
        });

        ctx.collectArtifacts({
          generatedAssetIds: createdAssets.map((a) => a.id),
        });

        const summary = `Exported ${createdAssets.length} platform deliverable${createdAssets.length === 1 ? "" : "s"}: ${exports
          .map((e) => `${e.preset.label} (${e.width}×${e.height})`)
          .join(", ")}.`;
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "export_layer_for_platforms",
          category: "canvas",
          summary,
          artifacts: { generatedAssetIds: createdAssets.map((a) => a.id) },
          input: { layerId, presetIds, fit: fit ?? "cover" },
          output: {
            assetIds: createdAssets.map((a) => a.id),
            sizes: exports.map((e) => ({ presetId: e.presetId, width: e.width, height: e.height })),
          },
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
        });

        return {
          ok: true,
          assetIds: createdAssets.map((a) => a.id),
          exports: exports.map((e) => ({
            presetId: e.presetId,
            label: e.preset.label,
            width: e.width,
            height: e.height,
            bytes: e.bytes.byteLength,
          })),
          summary,
        };
      } catch (error) {
        if (jobId) {
          await failRunningGenerationJob({ jobId, error, fallbackCode: "export_error" });
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "export_layer_for_platforms",
          category: "canvas",
          summary: `Platform export failed: ${message.slice(0, 200)}`,
          artifacts: {},
          input: { layerId, presetIds },
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
