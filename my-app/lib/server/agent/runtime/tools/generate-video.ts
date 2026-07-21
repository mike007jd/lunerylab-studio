/**
 * generate_video — start a video generation job in the background.
 *
 * Wraps the existing `runVideoJob` async pipeline. Returns the jobId
 * immediately so the agent can finish without blocking on long-running video
 * rendering. The Library / Job UI surfaces the result when it lands.
 */

import { tool, type Tool } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runVideoJob } from "@/lib/server/video-job";
import { resolveVideoRuntime } from "@/lib/server/video-runtime";
import { normalizeDuration } from "@/lib/video-models";
import { resolveVideoModelEntry } from "@/lib/server/model-catalog";
import { readStoredFile } from "@/lib/server/storage";
import { createGenerationJob, failRunningGenerationJob } from "@/lib/server/generation-job";
import { loadAgentLayer } from "@/lib/server/agent/runtime/layer-access";
import type { AgentToolContext } from "@/lib/server/agent/runtime/tool-registry";

export function buildGenerateVideoTool(ctx: AgentToolContext): Tool {
  return tool({
    description:
      "Start a background video generation job. If a layerId is provided and the model supports image-to-video, that layer's asset becomes the reference frame. The job runs asynchronously; the result appears in the Library when done.",
    inputSchema: z.object({
      prompt: z.string().min(3).describe("Refined video prompt."),
      durationSeconds: z
        .number()
        .int()
        .min(4)
        .max(15)
        .optional()
        .describe("Clip length in seconds (4-15). Default 6."),
      aspectRatio: z.string().optional(),
      modelId: z.string().optional(),
      layerId: z
        .string()
        .optional()
        .describe("Optional source layer for image-to-video models."),
    }),
    async execute({ prompt, durationSeconds, aspectRatio, modelId, layerId }) {
      const startedAt = new Date().toISOString();
      const stepId = randomUUID();
      let jobId: string | null = null;

      try {
        // No default video model — the user must explicitly choose one. The
        // agent passes through the Studio's selected modelId; if missing,
        // surface a clear "pick a model" error rather than silently routing.
        const requestedModelId = modelId?.trim();
        if (!requestedModelId) {
          return {
            ok: false,
            error:
              "No video model selected. Pick a video model in the Studio composer (or connect a BYOK video provider in Settings).",
          };
        }
        const model = await resolveVideoModelEntry(requestedModelId);
        if (!model) {
          return { ok: false, error: `Unknown video model id: ${requestedModelId}` };
        }
        const duration = normalizeDuration(model, durationSeconds ?? 6);

        let referenceBuffer: Buffer | undefined;
        if (layerId) {
          const loaded = await loadAgentLayer(ctx, layerId, {
            requireImage: true,
            imageRequiredMessage: `Layer ${layerId} is not an image and cannot be used as a video reference.`,
          });
          if (!loaded.ok) return { ok: false, error: loaded.error };
          referenceBuffer = Buffer.from((await readStoredFile(loaded.layer.asset.storagePath)).file);
        }

        // Freeze backend/model at submission so the background runner can't
        // drift to a different provider/model if Settings change mid-flight.
        // Resolve BEFORE creating the job: if this throws, no RUNNING job is left
        // orphaned (the old order created the job first, so a resolve failure
        // stranded it as permanently RUNNING).
        const videoRuntime = await resolveVideoRuntime(model.id);

        const job = await createGenerationJob({
          userId: ctx.userId,
          projectId: ctx.projectId,
          source: "STUDIO",
          prompt,
          referenceCount: referenceBuffer ? 1 : 0,
          requestedCount: 1,
          provider: "pending",
          model: model.providerModelId,
          type: "video",
          videoDuration: duration,
        });
        jobId = job.id;

        // Fire-and-forget; runVideoJob owns its own DB updates.
        runVideoJob({
          jobId: job.id,
          userId: ctx.userId,
          projectId: ctx.projectId,
          modelId: model.id,
          prompt,
          durationSeconds: duration,
          aspectRatio: aspectRatio || ctx.uiContext.selectedAspectRatio,
          referenceImage: referenceBuffer,
          runtime: videoRuntime,
          agentTaskId: ctx.taskId,
        }).catch((error) => {
          console.error("[agent:video_job_failed]", error);
        });

        ctx.collectArtifacts({ videoJobId: job.id });
        const summary = `Started video job (${model.id}, ${duration}s).`;
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "generate_video",
          category: "generation",
          summary,
          artifacts: { videoJobId: job.id },
          input: { prompt, durationSeconds: duration, modelId: model.id, layerId },
          output: { jobId: job.id },
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
        });

        return {
          ok: true,
          jobId: job.id,
          summary,
          note: "Video runs async. The user can keep working; result lands in Library when done.",
        };
      } catch (error) {
        // If a job was already created before the failure, mark it FAILED so it
        // never lingers as a permanently RUNNING job.
        if (jobId) {
          await failRunningGenerationJob({ jobId, error, fallbackCode: "video_submit_failed" });
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "generate_video",
          category: "generation",
          summary: `Video job submit failed: ${message.slice(0, 200)}`,
          artifacts: {},
          input: { prompt, durationSeconds, modelId, layerId },
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
