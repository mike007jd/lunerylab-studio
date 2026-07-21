/**
 * Image-edit agent tools — inpaint, background-remove, controlnet.
 *
 * All three operate on a canvas layer's source image and write the result back
 * as a new layer (hiding the original). They route through whichever fal
 * connection the user has configured: fal is the only BYOK provider in the
 * default catalog that exposes structured image-edit model ids. Replicate has
 * many variants but requires the user to know specific model paths.
 *
 * For inpaint, the mask comes from either a short-lived canvas mask token or
 * the agent context's `region` (the rectangle the user marked on canvas).
 */

import { tool, type Tool } from "ai";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { safeSharp } from "@/lib/server/image-safety";
import { clampBboxToImage } from "@/lib/server/image-compose";
import { z } from "zod";
import { ApiError } from "@/lib/server/errors";
import { readStoredFile } from "@/lib/server/storage";
import {
  deleteTemporaryCanvasMask,
  isTemporaryCanvasMaskToken,
  readTemporaryCanvasMask,
} from "@/lib/server/canvas-temporary-mask";
import { loadAgentLayer } from "@/lib/server/agent/runtime/layer-access";
import { saveResultAsReplacementLayer } from "@/lib/server/agent/runtime/replacement-layer";
import {
  completeGenerationJob,
  createGenerationJob,
  failRunningGenerationJob,
} from "@/lib/server/generation-job";
import { listByokConnectionMeta } from "@/lib/server/byok-connection-store";
import {
  bufferToDataUrl,
  downloadImageFromUrl,
} from "@/lib/server/byok-shared";
import { falQueueSubmit } from "@/lib/server/byok-provider-clients";
import { resolveByokProviderConfig } from "@/lib/server/byok-provider-config";
import type { AgentToolContext } from "@/lib/server/agent/runtime/tool-registry";

function pickFalProviderId(): string | null {
  const connections = listByokConnectionMeta();
  if (connections.fal) return "fal";
  return null;
}

interface FalImageResult {
  image?: { url?: string };
  images?: Array<{ url?: string }>;
}

interface FalEditConfig {
  providerId: string;
  apiKey: string;
  apiBase: string;
  modelPath: string;
}

async function resolveFalEditConfig(
  providerId: string,
  kind: "inpaint" | "backgroundRemove",
  modelPathOverride: string | undefined,
): Promise<FalEditConfig> {
  const resolved = await resolveByokProviderConfig({
    providerId,
    validateProvider(meta) {
      if (!meta.capabilities.includes("image-edit")) {
        throw new ApiError({
          status: 400,
          code: "byok_image_edit_unsupported",
          message: `${meta.label} does not support image editing.`,
          retryable: false,
        });
      }
    },
    resolveModelId: ({ meta }) => modelPathOverride?.trim() || meta.imageEditModels?.[kind],
    missingEndpointMessage: (meta) => `${meta.label} image editing is missing an endpoint. Open Settings to configure.`,
    missingModelMessage: () =>
      kind === "inpaint"
        ? "Fal inpaint model metadata is missing. Refresh provider metadata before running this tool."
        : "Fal background-removal model metadata is missing. Refresh provider metadata before running this tool.",
  });
  return {
    providerId,
    apiKey: resolved.apiKey,
    apiBase: resolved.endpoint,
    modelPath: resolved.modelId,
  };
}

/**
 * Run a fal image-edit model through the shared queue client. The edit lane
 * uses a 4-minute deadline (inpaint/bg-remove are interactive); the generic
 * queue/poll/auth envelope lives in byok-shared.falQueueSubmit.
 */
async function callFal(
  config: FalEditConfig,
  body: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  const url = await falQueueSubmit<FalImageResult>({
    apiKey: config.apiKey,
    apiBase: config.apiBase,
    modelPath: config.modelPath,
    body,
    extractUrl: (p) => p.image?.url ?? p.images?.[0]?.url,
    deadlineMs: 4 * 60_000,
    label: "Fal edit",
    abortSignal,
  });
  const image = await downloadImageFromUrl(url, { timeoutMs: 30_000 });
  return image.bytes;
}

/**
 * Build a binary mask PNG from a rectangle (white inside the rect = editable
 * region). Sharp is the only image library guaranteed available server-side.
 */
async function buildRectMask(
  fullWidth: number,
  fullHeight: number,
  rect: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  // Shared finite/clamp strategy with cropRegion — a NaN/negative/out-of-range
  // region is coerced into the image bounds instead of producing a bad mask.
  const { left: x, top: y, width: w, height: h } = clampBboxToImage(rect, fullWidth, fullHeight);
  const whiteRect = await sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: fullWidth,
      height: fullHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([{ input: whiteRect, top: y, left: x }])
    .png()
    .toBuffer();
}

async function readUploadedMask(
  ctx: AgentToolContext,
  fullWidth: number,
  fullHeight: number,
): Promise<Buffer | null> {
  if (!ctx.maskAssetId) return null;
  if (!isTemporaryCanvasMaskToken(ctx.maskAssetId)) {
    throw new ApiError({
      status: 400,
      code: "invalid_canvas_mask",
      message: "Inpaint requires a temporary canvas mask.",
      retryable: false,
    });
  }
  const mask = await readTemporaryCanvasMask(ctx.maskAssetId);
  return safeSharp(mask)
    .resize(fullWidth, fullHeight, { fit: "fill" })
    .greyscale()
    .png()
    .toBuffer();
}

// saveResultAsReplacementLayer lives in ../replacement-layer.ts so the
// edit-layer tool shares the exact hide-original + create-top-z + rollback path.

// ---------------------------------------------------------------------------
// inpaint_layer
// ---------------------------------------------------------------------------

export function buildInpaintLayerTool(ctx: AgentToolContext): Tool {
  return tool({
    description:
      "Inpaint a region of a canvas layer using the configured fal BYOK inpaint model. If a temporary canvas mask exists in context it is used as the exact editable mask; otherwise the marked region rectangle is used. Output replaces the original layer (which is hidden).",
    inputSchema: z.object({
      layerId: z.string().min(1),
      prompt: z.string().min(3).describe("What the masked region should become."),
      modelPath: z
        .string()
        .optional()
        .describe("Optional fal model id override. Empty uses the verified provider metadata in Settings."),
    }),
    async execute({ layerId, prompt, modelPath }) {
      const startedAt = new Date().toISOString();
      const stepId = randomUUID();
      const temporaryMaskToken = isTemporaryCanvasMaskToken(ctx.maskAssetId)
        ? ctx.maskAssetId
        : null;
      let jobId: string | null = null;
      try {
        const providerId = pickFalProviderId();
        if (!providerId) {
          return { ok: false, error: "Fal BYOK is not connected. Open Settings → Providers." };
        }
        const editConfig = await resolveFalEditConfig(providerId, "inpaint", modelPath);
        const targetModel = editConfig.modelPath;
        const loaded = await loadAgentLayer(ctx, layerId, {
          requireImage: true,
          requireUnlocked: true,
          lockedMessage: `Layer ${layerId} is locked and cannot be edited by the agent.`,
          imageRequiredMessage: "Inpaint requires an image layer.",
        });
        if (!loaded.ok) return { ok: false, error: loaded.error };
        const { layer } = loaded;
        const region = ctx.region;
        if (!region && !ctx.maskAssetId) {
          return {
            ok: false,
            error: "Inpaint requires a marked region. Have the user draw a rectangle first.",
          };
        }

        const job = await createGenerationJob({
          userId: ctx.userId,
          projectId: ctx.projectId,
          source: "STUDIO",
          toolType: "inpaint",
          prompt,
          referenceCount: 1,
          requestedCount: 1,
          provider: `byok:${providerId}`,
          model: targetModel,
        });
        jobId = job.id;

        const stored = await readStoredFile(layer.asset.storagePath);
        const sourceBuffer = Buffer.from(stored.file);
        const meta2 = await safeSharp(sourceBuffer).metadata();
        const fullW = meta2.width ?? Math.round(layer.width);
        const fullH = meta2.height ?? Math.round(layer.height);
        const uploadedMask = await readUploadedMask(ctx, fullW, fullH);
        const mask =
          uploadedMask ??
          (await (async () => {
            if (!region) {
              throw new ApiError({
                status: 400,
                code: "invalid_request",
                message: "Inpaint requires a mask or marked region.",
                retryable: false,
              });
            }
            // Scale region (canvas units) to image pixels.
            const scaleX = fullW / layer.width;
            const scaleY = fullH / layer.height;
            return buildRectMask(fullW, fullH, {
              x: region.bbox.x * scaleX,
              y: region.bbox.y * scaleY,
              width: region.bbox.width * scaleX,
              height: region.bbox.height * scaleY,
            });
          })());

        const result = await callFal(
          editConfig,
          {
            prompt,
            image_url: bufferToDataUrl(sourceBuffer),
            mask_url: bufferToDataUrl(mask),
            num_images: 1,
          },
          ctx.abortSignal,
        );

        const written = await saveResultAsReplacementLayer(
          ctx,
          {
            id: layer.id,
            x: layer.x,
            y: layer.y,
            width: layer.width,
            height: layer.height,
          },
          result,
          job.id,
        );

        await completeGenerationJob({
          jobId,
          model: targetModel,
          provider: `byok:${providerId}`,
          successCount: 1,
          requestedCount: 1,
        });

        ctx.collectArtifacts({
          generatedAssetIds: [written.assetId],
          createdLayerIds: [written.layerId],
          modifiedLayerIds: [layer.id],
        });
        await ctx.refreshSnapshot();
        const summary = `Inpainted masked region of layer ${layer.id}.`;
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "inpaint_layer",
          category: "generation",
          summary,
          artifacts: {
            generatedAssetIds: [written.assetId],
            createdLayerIds: [written.layerId],
            modifiedLayerIds: [layer.id],
          },
          input: { layerId, prompt, modelPath: targetModel },
          output: { newLayerId: written.layerId },
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
        });
        return { ok: true, newLayerId: written.layerId, summary };
      } catch (error) {
        if (jobId) {
          await failRunningGenerationJob({ jobId, error, fallbackCode: "inpaint_error" });
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "inpaint_layer",
          category: "generation",
          summary: `Inpaint failed: ${message.slice(0, 200)}`,
          artifacts: {},
          input: { layerId, prompt },
          status: "failed",
          startedAt,
          completedAt: new Date().toISOString(),
          errorMessage: message,
        });
        return { ok: false, error: message.slice(0, 400) };
      } finally {
        if (temporaryMaskToken) {
          await deleteTemporaryCanvasMask(temporaryMaskToken).catch(() => {});
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// remove_background
// ---------------------------------------------------------------------------

export function buildRemoveBackgroundTool(ctx: AgentToolContext): Tool {
  return tool({
    description:
      "Remove the background of a canvas layer via the configured fal background-removal model. Output replaces the original layer (which is hidden).",
    inputSchema: z.object({
      layerId: z.string().min(1),
      modelPath: z
        .string()
        .optional()
        .describe("Optional fal model id override. Empty uses the verified provider metadata in Settings."),
    }),
    async execute({ layerId, modelPath }) {
      const startedAt = new Date().toISOString();
      const stepId = randomUUID();
      const providerId = pickFalProviderId();
      if (!providerId) {
        return { ok: false, error: "Fal BYOK is not connected. Open Settings → Providers." };
      }

      let jobId: string | null = null;
      try {
        const editConfig = await resolveFalEditConfig(providerId, "backgroundRemove", modelPath);
        const targetModel = editConfig.modelPath;
        const loaded = await loadAgentLayer(ctx, layerId, {
          requireImage: true,
          requireUnlocked: true,
          lockedMessage: `Layer ${layerId} is locked and cannot be edited by the agent.`,
          imageRequiredMessage: "Background removal requires an image layer.",
        });
        if (!loaded.ok) return { ok: false, error: loaded.error };
        const { layer } = loaded;

        const job = await createGenerationJob({
          userId: ctx.userId,
          projectId: ctx.projectId,
          source: "STUDIO",
          toolType: "background",
          prompt: "background-remove",
          referenceCount: 1,
          requestedCount: 1,
          provider: `byok:${providerId}`,
          model: targetModel,
        });
        jobId = job.id;

        const stored = await readStoredFile(layer.asset.storagePath);
        const sourceBuffer = Buffer.from(stored.file);

        const result = await callFal(
          editConfig,
          {
            image_url: bufferToDataUrl(sourceBuffer),
          },
          ctx.abortSignal,
        );

        const written = await saveResultAsReplacementLayer(
          ctx,
          {
            id: layer.id,
            x: layer.x,
            y: layer.y,
            width: layer.width,
            height: layer.height,
          },
          result,
          job.id,
        );

        await completeGenerationJob({
          jobId,
          model: targetModel,
          provider: `byok:${providerId}`,
          successCount: 1,
          requestedCount: 1,
        });

        ctx.collectArtifacts({
          generatedAssetIds: [written.assetId],
          createdLayerIds: [written.layerId],
          modifiedLayerIds: [layer.id],
        });
        await ctx.refreshSnapshot();
        const summary = `Removed background of layer ${layer.id}.`;
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "remove_background",
          category: "generation",
          summary,
          artifacts: {
            generatedAssetIds: [written.assetId],
            createdLayerIds: [written.layerId],
            modifiedLayerIds: [layer.id],
          },
          input: { layerId, modelPath: targetModel },
          output: { newLayerId: written.layerId },
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
        });
        return { ok: true, newLayerId: written.layerId, summary };
      } catch (error) {
        if (jobId) {
          await failRunningGenerationJob({ jobId, error, fallbackCode: "bg_remove_error" });
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "remove_background",
          category: "generation",
          summary: `Background remove failed: ${message.slice(0, 200)}`,
          artifacts: {},
          input: { layerId },
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
