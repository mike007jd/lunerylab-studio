import { NextRequest, NextResponse } from "next/server";
import { assertVideoGenerationPrismaSupport } from "@/lib/server/prisma";
import { ApiError, jsonError } from "@/lib/server/errors";
import { parseFormData } from "@/lib/server/http-validation";
import { ensureAppState } from "@/lib/server/app-state";
import { normalizeDuration } from "@/lib/video-models";
import {
  assertRequestContentLength,
  validateFiles,
} from "@/lib/server/file-validation";
import { getMaxUploadBytesPerFile } from "@/lib/server/env";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { createOrReplayGenerationJob } from "@/lib/server/idempotency";
import { runVideoJob } from "@/lib/server/video-job";
import { createRouteTelemetry } from "@/lib/server/route-telemetry";
import { resolveVideoModelEntry } from "@/lib/server/model-catalog";
import { resolveVideoRuntime } from "@/lib/server/video-runtime";
import {
  buildRequestFingerprint,
  getUploadedFiles,
  resolveOwnedProjectId,
  trimFormString,
  trimFormStringOrNull,
  uploadedFileFingerprint,
} from "@/lib/server/generate-request";
import { failRunningGenerationJob } from "@/lib/server/generation-job";
import {
  loadRequiredImageReferenceFile,
  persistUploadedImageReferenceFiles,
} from "@/lib/server/reference-assets";

// Desktop-local video generation: POST returns RUNNING immediately and the
// started promise continues on the Node event loop. Terminal failures are
// observed here; orphan reconciliation remains on the status/read path.
export const maxDuration = 300;

function generationResponse({
  jobId,
  status,
  duration,
  projectId,
}: {
  jobId: string;
  status: string;
  duration: number | null;
  projectId: string | null;
}) {
  return NextResponse.json({ jobId, status, duration, projectId });
}

function observeVideoJob(promise: Promise<unknown>) {
  void promise.catch((error) => {
    console.error("[video_job_background_failed]", error);
  });
}

export async function POST(request: NextRequest) {
  const telemetry = createRouteTelemetry("/api/generate/video", request);
  telemetry.start();
  let jobId: string | null = null;

  try {
    const user = await requireLocalWorkspaceOwner();

    assertVideoGenerationPrismaSupport();

    assertRequestContentLength(request.headers, getMaxUploadBytesPerFile() + 64 * 1024);
    const formData = await parseFormData(request);
    const prompt = trimFormString(formData, "prompt");
    const modelId = trimFormString(formData, "modelId");
    const durationRaw = Number(formData.get("duration"));
    const providedProjectId = trimFormString(formData, "projectId");
    const referenceAssetId = trimFormStringOrNull(formData, "referenceAssetId");
    const referenceImageFiles = getUploadedFiles(formData, "referenceImage");
    await validateFiles(referenceImageFiles, { maxFiles: 1 });
    const referenceImage = referenceImageFiles[0] ?? null;
    const aspectRatio = trimFormString(formData, "aspectRatio") || undefined;
    const idempotencyKey = trimFormStringOrNull(formData, "idempotencyKey");

    if (!prompt) {
      throw new ApiError({
        status: 400,
        code: "missing_prompt",
        message: "Prompt is required.",
        retryable: false,
      });
    }

    const model = await resolveVideoModelEntry(modelId);
    if (!model) {
      throw new ApiError({
        status: 400,
        code: "invalid_model",
        message: `Unknown video model: ${modelId}`,
        retryable: false,
      });
    }

    const duration = normalizeDuration(model, durationRaw);

    const resolvedProjectId = await resolveOwnedProjectId(providedProjectId, user.id);

    let refBuffer: Buffer | undefined;
    if (!referenceImage && referenceAssetId) {
      refBuffer = (await loadRequiredImageReferenceFile({ assetId: referenceAssetId, userId: user.id })).bytes;
    }

    if (model.requiresImageInput && !referenceImage && !refBuffer) {
      throw new ApiError({
        status: 400,
        code: "reference_required",
        message: `Model ${model.id} requires a reference image.`,
        retryable: false,
      });
    }

    const videoTarget = await resolveVideoRuntime(model.id);
    const runtimeModelId = videoTarget.modelId ?? model.providerModelId;
    const requestFingerprint = buildRequestFingerprint({
      type: "video",
      prompt,
      requestedModelId: modelId,
      resolvedModelId: model.id,
      providerModelId: runtimeModelId,
      duration,
      aspectRatio: aspectRatio ?? null,
      projectId: resolvedProjectId,
      referenceAssetId,
      referenceImage: uploadedFileFingerprint(referenceImage),
    });

    const created = await createOrReplayGenerationJob({
      input: {
        userId: user.id,
        projectId: resolvedProjectId,
        source: "STUDIO",
        prompt,
        referenceCount: referenceImage || refBuffer ? 1 : 0,
        requestedCount: 1,
        provider: videoTarget.backend,
        model: runtimeModelId,
        type: "video",
        videoDuration: duration,
        idempotencyKey,
        requestFingerprint,
      },
      userId: user.id,
      requestFingerprint,
    });
    if (created.kind === "cached") {
      const cachedJob = created.job;
      const response = generationResponse({
        jobId: cachedJob.id,
        status: cachedJob.status,
        duration: cachedJob.videoDuration,
        projectId: cachedJob.projectId,
      });
      telemetry.done(response.status, { cached: true });
      return response;
    }
    const job = created.job;
    jobId = job.id;

    if (referenceImage) {
      refBuffer = (
        await persistUploadedImageReferenceFiles({
          projectId: resolvedProjectId,
          jobId: job.id,
          files: [referenceImage],
          userId: user.id,
        })
      )[0]?.bytes;
    }

    if (model.requiresImageInput && !refBuffer) {
      throw new ApiError({
        status: 400,
        code: "reference_required",
        message: `Model ${model.id} requires a reference image.`,
        retryable: false,
      });
    }

    observeVideoJob(
      runVideoJob({
        jobId: job.id,
        userId: user.id,
        projectId: resolvedProjectId,
        modelId: model.id,
        prompt,
        durationSeconds: duration,
        aspectRatio,
        referenceImage: refBuffer,
        // Freeze the backend/model resolved above so the background runner
        // can't drift if Settings change mid-flight.
        runtime: videoTarget,
      }),
    );

    const responseBody: {
      jobId: string;
      status: string;
      duration: number | null;
      projectId: string | null;
      warnings?: string[];
    } = {
      jobId: job.id,
      status: "RUNNING",
      duration,
      projectId: resolvedProjectId,
    };
    if (videoTarget.warnings.length > 0) {
      responseBody.warnings = videoTarget.warnings;
    }
    const response = NextResponse.json(responseBody);
    telemetry.done(response.status);
    return response;
  } catch (error) {
    if (jobId) {
      await failRunningGenerationJob({ jobId, error, fallbackCode: "video_generation_failed" });
    }

    telemetry.failed(error);
    return jsonError(error);
  } finally {
    await ensureAppState();
  }
}
