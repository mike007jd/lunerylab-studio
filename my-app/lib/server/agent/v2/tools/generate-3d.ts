/**
 * generate_3d — turn a canvas layer's image into a 3D model (GLB by default)
 * via a configured 3D-capable BYOK provider.
 *
 * The resulting GLB is saved as a new MODEL_3D asset attached to the project.
 * It is NOT added as a canvas layer — the canvas surface today renders 2D
 * only; the agent surfaces the assetId so the UI can show a model-viewer card
 * (or push it to Library where the user downloads it).
 */

import { tool, type Tool } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generateModel3dByok } from "@/lib/server/byok-3d";
import { deleteStoredFile, readStoredFile, writeGenerated3dModel } from "@/lib/server/storage";
import { withUserStorageQuota } from "@/lib/server/file-validation";
import {
  completeGenerationJob,
  createGenerationJob,
  failRunningGenerationJob,
} from "@/lib/server/generation-job";
import { findByokProvider, isModel3dCapableByok } from "@/lib/byok-providers";
import { listByokConnectionMeta } from "@/lib/server/byok-connection-store";
import { fetchConfiguredProviderIds } from "@/lib/server/byok-shared";
import { selectConfiguredModel3dProvider } from "@/lib/server/model3d-provider-selection";
import { loadAgentLayer } from "@/lib/server/agent/v2/layer-access";
import type { AgentToolContext } from "@/lib/server/agent/v2/tool-registry";

async function pickModel3dProvider(): Promise<string | null> {
  const [connections, configuredProviderIds] = await Promise.all([
    Promise.resolve(listByokConnectionMeta()),
    fetchConfiguredProviderIds(),
  ]);
  return selectConfiguredModel3dProvider(connections, configuredProviderIds);
}

export function buildGenerate3dTool(ctx: AgentToolContext): Tool {
  return tool({
    description:
      "Generate a 3D model (.glb) from a canvas layer's image using a configured 3D-capable BYOK provider. The result is saved as a new MODEL_3D asset under the project; it is NOT placed on the canvas (the surface is 2D-only). Returns the assetId for download / preview.",
    inputSchema: z.object({
      layerId: z.string().min(1).describe("Source canvas layer (its image becomes the 3D input)."),
      prompt: z
        .string()
        .optional()
        .describe("Optional text prompt for provider schemas that accept it. Helps steer style."),
      format: z
        .enum(["glb", "obj", "fbx"])
        .optional()
        .describe("Preferred export format. Defaults to glb."),
      providerId: z
        .string()
        .optional()
        .describe("Override the BYOK provider id."),
    }),
    async execute({ layerId, prompt, format, providerId }) {
      const startedAt = new Date().toISOString();
      const stepId = randomUUID();
      let jobId: string | null = null;

      const chosenProvider = providerId?.trim() || (await pickModel3dProvider());
      if (!chosenProvider) {
        return {
          ok: false,
          error:
            "No 3D-capable BYOK provider is configured. Connect a 3D provider in Settings → Providers.",
        };
      }
      if (!isModel3dCapableByok(chosenProvider)) {
        return {
          ok: false,
          error: `Provider "${chosenProvider}" does not support 3D model generation.`,
        };
      }

      try {
        const loaded = await loadAgentLayer(ctx, layerId, {
          requireImage: true,
          imageRequiredMessage: `Layer ${layerId} is not an image and cannot be used for 3D generation.`,
        });
        if (!loaded.ok) return { ok: false, error: loaded.error };
        const { layer } = loaded;

        const stored = await readStoredFile(layer.asset.storagePath);
        const referenceImage = Buffer.from(stored.file);

        const job = await createGenerationJob({
          userId: ctx.userId,
          projectId: ctx.projectId,
          source: "STUDIO",
          toolType: "model-3d",
          prompt: prompt ?? "image-to-3d",
          referenceCount: 1,
          requestedCount: 1,
          provider: `byok:${chosenProvider}`,
          // Job tag for telemetry — fall back to the operation label only for
          // providers with a fixed operation mode (Meshy / Tripo); otherwise
          // mark as user-pending so the dispatcher's `byok_not_configured`
          // error makes it clear no model was chosen.
          model:
            findByokProvider(chosenProvider)?.fixedModel3dOperation ??
            "user-selected",
          type: "model-3d",
        });
        jobId = job.id;

        const result = await generateModel3dByok(
          { referenceImage, prompt, format, abortSignal: ctx.abortSignal },
          chosenProvider,
        );

        const storedModel = await writeGenerated3dModel(result.bytes, ctx.projectId);

        // Asset + job terminal state commit atomically; the file is deleted if
        // the transaction rolls back.
        const createdAsset = await withUserStorageQuota(
          ctx.userId,
          storedModel.byteSize,
          async (tx) => {
            const asset = await tx.asset.create({
              data: {
                userId: ctx.userId,
                projectId: ctx.projectId,
                jobId: job.id,
                kind: "GENERATED",
                modality: "MODEL_3D",
                storagePath: storedModel.storagePath,
                mimeType: storedModel.mimeType,
                byteSize: storedModel.byteSize,
                format: result.format,
              },
            });
            await completeGenerationJob({
              jobId: job.id,
              model: result.model,
              provider: result.provider,
              successCount: 1,
              requestedCount: 1,
              client: tx,
            });
            return asset;
          },
        ).catch(async (error) => {
          await deleteStoredFile(storedModel.storagePath);
          throw error;
        });

        ctx.collectArtifacts({ generatedAssetIds: [createdAsset.id] });
        const summary = `Generated 3D model (.${result.format}, ${(result.bytes.byteLength / 1024 / 1024).toFixed(1)} MB) via ${chosenProvider}.`;
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "generate_3d",
          category: "generation",
          summary,
          artifacts: { generatedAssetIds: [createdAsset.id] },
          input: { layerId, providerId: chosenProvider, format: result.format },
          output: {
            assetId: createdAsset.id,
            format: result.format,
            sizeBytes: result.bytes.byteLength,
          },
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
        });

        return {
          ok: true,
          assetId: createdAsset.id,
          format: result.format,
          provider: chosenProvider,
          summary,
          note: "3D asset saved under Library. The 2D canvas does not render 3D inline yet.",
        };
      } catch (error) {
        if (jobId) {
          await failRunningGenerationJob({ jobId, error, fallbackCode: "model_3d_error" });
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "generate_3d",
          category: "generation",
          summary: `3D generation failed: ${message.slice(0, 200)}`,
          artifacts: {},
          input: { layerId, providerId: chosenProvider },
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
