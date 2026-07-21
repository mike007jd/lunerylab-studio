// Background video job runner. Called via fire-and-forget from API routes /
// agent runner; on Vercel the caller should wrap this in `waitUntil(...)` so
// the function instance stays alive long enough for the BYOK video call to
// complete (typically 1–10 minutes). On Tauri, `waitUntil` is a
// no-op shim and the Promise simply lives on the Node event loop.
//
// The backend + model are resolved by the caller (via `resolveVideoRuntime`)
// and frozen into `input.runtime` at submission time; this runner trusts that
// target and never re-resolves, so a Settings change between submit and
// execution can't make the job drift. A frozen backend of "none" fails the job
// with a structured error so the UI can point the user at the right Settings
// panel.

import "server-only";
import { ApiError } from "@/lib/server/errors";
import { deleteStoredFile, writeGeneratedVideo } from "@/lib/server/storage";
import { withAssetWriteTransaction } from "@/lib/server/file-validation";
import { generateVideoByok } from "@/lib/server/byok-video";
import type { VideoRuntimeTarget } from "@/lib/server/video-runtime";
import {
  completeGenerationJob,
  failRunningGenerationJob,
} from "@/lib/server/generation-job";

interface RunVideoJobInput {
  jobId: string;
  userId: string;
  projectId: string | null;
  modelId: string;
  prompt: string;
  durationSeconds: number;
  aspectRatio?: string;
  referenceImage?: Buffer;
  /**
   * Backend + model frozen at submission time. The runner trusts this and does
   * NOT re-resolve, so a Settings change between submit and execution can't make
   * the background job drift to a different provider/model.
   */
  runtime: VideoRuntimeTarget;
  /** Present for Luna-originated jobs so async output keeps task provenance. */
  agentTaskId?: string;
  /** Optional cancel signal forwarded to the provider request. */
  abortSignal?: AbortSignal;
}

interface VideoCallResult {
  provider: string;
  model: string;
  video: { bytes: Buffer; mimeType: string };
}

export async function runVideoJob(input: RunVideoJobInput): Promise<void> {
  // Backend was frozen at submission — never re-resolve here (no model drift).
  const runtime = input.runtime;
  if (runtime.backend === "none") {
    await failJob(
      input,
      "no_video_backend",
      "No video backend is configured. Connect a BYOK provider (fal / replicate / minimax).",
    );
    return;
  }

  try {
    let result: VideoCallResult;
    if (runtime.backend === "byok" && runtime.providerId) {
      const byok = await generateVideoByok(
        {
          prompt: input.prompt,
          modelId: runtime.modelId,
          durationSeconds: input.durationSeconds,
          aspectRatio: input.aspectRatio,
          referenceImage: input.referenceImage,
          abortSignal: input.abortSignal,
        },
        runtime.providerId,
      );
      result = byok;
    } else {
      await failJob(input, "no_video_backend", "No BYOK video backend is configured.");
      return;
    }

    const stored = await writeGeneratedVideo(result.video.bytes, input.projectId);

    // Asset creation AND the job's terminal state commit in the same
    // transaction so we never leave a successful asset under a FAILED job (or an
    // asset whose row was deleted but file kept). On rollback we delete the file.
    await withAssetWriteTransaction(async (tx) => {
      await tx.asset.create({
        data: {
          userId: input.userId,
          projectId: input.projectId || undefined,
          jobId: input.jobId,
          kind: "GENERATED",
          modality: "VIDEO",
          storagePath: stored.storagePath,
          mimeType: stored.mimeType,
          byteSize: stored.byteSize,
          format: stored.mimeType.split("/")[1] ?? "mp4",
          durationSeconds: input.durationSeconds,
          agentTaskId: input.agentTaskId,
          summary: input.agentTaskId ? input.prompt.slice(0, 280) : undefined,
        },
      });
      await completeGenerationJob({
        jobId: input.jobId,
        model: result.model,
        provider: result.provider,
        successCount: 1,
        requestedCount: 1,
        client: tx,
      });
    }).catch(async (error) => {
      await deleteStoredFile(stored.storagePath);
      throw error;
    });
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "video_generation_failed";
    const message =
      error instanceof Error
        ? error.message
        : "Video generation failed unexpectedly.";
    await failJob(input, code, message);
  }
}

async function failJob(input: RunVideoJobInput, errorCode: string, errorMessage: string) {
  await failRunningGenerationJob({
    jobId: input.jobId,
    error: new ApiError({
      status: 500,
      code: errorCode,
      message: errorMessage,
      retryable: true,
    }),
    fallbackCode: errorCode,
  });
}
