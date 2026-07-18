import { NextRequest, NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/server/errors";
import { ensureAppState } from "@/lib/server/app-state";
import { generateImages } from "@/lib/server/image-generate";
import { toAssetDTO } from "@/lib/server/dto";
import {
  assertRequestContentLength,
  validateFiles,
  withUserStorageQuota,
} from "@/lib/server/file-validation";
import { deleteStoredFile, writeFilesOrCleanup, writeGeneratedImage } from "@/lib/server/storage";
import { parseRequestedAspectRatio } from "@/lib/server/byok-shared";
import { parseFormData } from "@/lib/server/http-validation";
import { findPresetById } from "@/lib/presets/style-presets";
import { findToolById } from "@/lib/tools/catalog";
import { buildToolPrompt, getToolOverrides } from "@/lib/tools/tool-prompts";
import { mergePresetPrompt } from "@/lib/server/prompt-merge";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { createOrReplayGenerationJob } from "@/lib/server/idempotency";
import { createRouteTelemetry } from "@/lib/server/route-telemetry";
import { resolveImageModelForGeneration } from "@/lib/server/resolve-image-model";
import {
  assertReferenceLimit,
  buildRequestFingerprint,
  firstNonEmptyFormString,
  getUploadedFiles,
  parseRequestedImageCount,
  parseRepeatedFormStrings,
  resolveOwnedProjectId,
  trimFormString,
  trimFormStringOrNull,
  uploadedFileFingerprint,
} from "@/lib/server/generate-request";
import { completeGenerationJob, failRunningGenerationJob } from "@/lib/server/generation-job";
import { getMaxUploadBytesPerFile } from "@/lib/server/env";
import {
  loadImageReferenceFiles,
  persistUploadedImageReferenceFiles,
} from "@/lib/server/reference-assets";
import { finishSdProgress, resolveSdRunId } from "@/lib/server/sd-progress";

function toJobPayload(job: {
  id: string;
  status: string;
  requestedCount: number;
  successCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  projectId: string | null;
}) {
  return {
    id: job.id,
    status: job.status,
    requestedCount: job.requestedCount,
    successCount: job.successCount,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    projectId: job.projectId,
  };
}

function generationResponse({
  job,
  assets,
  warnings,
}: {
  job: { id: string; status: string; requestedCount: number; successCount: number; errorCode: string | null; errorMessage: string | null; projectId: string | null };
  assets: unknown[];
  warnings: string[];
}) {
  return NextResponse.json({ job: toJobPayload(job), assets, warnings });
}

async function deleteStoredFiles(storagePaths: string[]) {
  await Promise.allSettled(storagePaths.map((storagePath) => deleteStoredFile(storagePath)));
}

function assertGenerationRequestActive(request: NextRequest) {
  if (!request.signal.aborted) return;
  throw new ApiError({
    status: 499,
    code: "request_aborted",
    message: "Image generation was cancelled.",
    retryable: false,
  });
}

export async function POST(request: NextRequest) {
  const telemetry = createRouteTelemetry("/api/generate/images", request);
  telemetry.start();

  let jobId: string | null = null;
  let runId: string | null = null;

  try {
    const user = await requireLocalWorkspaceOwner();

    assertRequestContentLength(request.headers, getMaxUploadBytesPerFile() * 4 + 128 * 1024);
    const formData = await parseFormData(request);
    runId = resolveSdRunId(formData.get("runId"));

    const rawPrompt = trimFormString(formData, "prompt");
    const count = parseRequestedImageCount(formData.get("count"));
    // Reject an unsupported ratio (e.g. "2:1") with 400 instead of silently
    // snapping to 1:1 — the request and the output must agree.
    const aspectRatioRaw = formData.get("aspectRatio");
    const aspectRatio = parseRequestedAspectRatio(
      typeof aspectRatioRaw === "string" ? aspectRatioRaw : undefined,
    );
    const presetId = trimFormStringOrNull(formData, "presetId");

    const modelId = firstNonEmptyFormString(formData, ["modelId", "model"]);
    const providedProjectId = trimFormString(formData, "projectId");
    const toolType = trimFormStringOrNull(formData, "toolType");
    const toolOverrides = getToolOverrides(toolType as Parameters<typeof getToolOverrides>[0]);
    const source: "STUDIO" | "TOOL" = toolType ? "TOOL" : "STUDIO";

    const idempotencyKey = trimFormStringOrNull(formData, "idempotencyKey");

    // Tool-specific prompt template takes precedence over preset
    let prompt = rawPrompt;
    if (toolType) {
      prompt = buildToolPrompt(toolType as Parameters<typeof buildToolPrompt>[0], rawPrompt);
    } else {
      const preset = presetId ? findPresetById(presetId) : null;
      if (preset) {
        prompt = await mergePresetPrompt(preset.promptGuidance, prompt);
      }
    }
    const files = getUploadedFiles(formData, "files");
    await validateFiles(files, { maxFiles: 4 });
    const referenceAssetIds = parseRepeatedFormStrings(formData, "referenceAssetIds");
    // Cap total references (files + unique asset ids) at the boundary, before
    // any reference file is read — 400 instead of a silent slice(0,4) later.
    assertReferenceLimit(files.length, referenceAssetIds.length);
    const referenceCount = files.length + referenceAssetIds.length;
    const requiresReferenceModel = referenceCount > 0;

    if (!prompt && files.length === 0 && referenceAssetIds.length === 0) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "Provide prompt, files, or referenceAssetIds.",
        retryable: false,
      });
    }

    const selectedTool = findToolById(toolType);
    if (toolType && !selectedTool) {
      throw new ApiError({
        status: 400,
        code: "invalid_tool",
        message: `Unknown tool type: ${toolType}`,
        retryable: false,
      });
    }

    // Tool-specific: require reference image for tools that transform inputs.
    if (toolType && selectedTool?.requiresReference && referenceCount === 0) {
      throw new ApiError({
        status: 400,
        code: "tool_requires_reference",
        message: "This tool requires at least one reference image.",
        retryable: false,
      });
    }
    const requiresEditModel = toolOverrides.isEdit || requiresReferenceModel;
    const resolvedModel = await resolveImageModelForGeneration({
      modelId,
      requiresEdit: requiresEditModel,
    });
    const modelEntry = resolvedModel.model;
    const pendingProvider = "pending";

    const projectId = await resolveOwnedProjectId(providedProjectId, user.id);
    const effectiveAspectRatio = toolOverrides.targetSize ? "1:1" : aspectRatio;
    const requestFingerprint = buildRequestFingerprint({
      type: "image",
      prompt,
      requestedModelId: modelId ?? null,
      resolvedModelId: modelEntry.id,
      providerModelId: modelEntry.providerModelId,
      count,
      aspectRatio: effectiveAspectRatio ?? null,
      toolType,
      presetId,
      projectId,
      source,
      referenceAssetIds,
      files: files.map(uploadedFileFingerprint),
    });

    const created = await createOrReplayGenerationJob({
      input: {
        userId: user.id,
        projectId,
        source,
        toolType,
        prompt,
        referenceCount,
        requestedCount: count,
        provider: pendingProvider,
        model: "pending",
        idempotencyKey,
        requestFingerprint,
      },
      userId: user.id,
      requestFingerprint,
    });
    if (created.kind === "cached") {
      const { job: cachedJob, assets: cachedAssets } = created;
      const response = generationResponse({
        job: cachedJob,
        assets: cachedJob.status === "RUNNING" ? [] : cachedAssets.map(toAssetDTO),
        warnings: [],
      });
      telemetry.done(response.status, { cached: true });
      return response;
    }
    const job = created.job;
    jobId = job.id;

    const assetReferences = await loadImageReferenceFiles({
      assetIds: referenceAssetIds,
      projectId,
      userId: user.id,
      invalidMessage: "One or more referenceAssetIds are missing or are not images.",
    });
    const uploadedReferences = await persistUploadedImageReferenceFiles({
      projectId,
      jobId: job.id,
      files,
      userId: user.id,
    });
    const references = [...assetReferences, ...uploadedReferences];

    const generation = await generateImages({
      runId,
      prompt,
      modelId: modelEntry.id,
      count,
      aspectRatio: effectiveAspectRatio,
      references: references.map((reference) => reference.bytes),
      isEdit: requiresEditModel,
      // User "Stop" / disconnect aborts the in-flight provider request.
      abortSignal: request.signal,
    });
    assertGenerationRequestActive(request);

    // Write images to storage first (I/O), then batch-create DB records. The
    // batch is all-or-nothing for cleanup: a partial write failure deletes the
    // images that already landed instead of orphaning them.
    const storedImages = await writeFilesOrCleanup(
      generation.images.map(
        (image) => () =>
          writeGeneratedImage({ bytes: image.bytes, projectId: projectId || undefined }),
      ),
    );
    if (request.signal.aborted) {
      await deleteStoredFiles(storedImages.map((stored) => stored.storagePath));
      assertGenerationRequestActive(request);
    }

    // Asset creation AND the job's terminal state commit in the same
    // transaction, so we can never end up with successful assets attached to a
    // FAILED job (or a SUCCEEDED job with no assets). Files are deleted if the
    // transaction rolls back.
    const { createdAssets, updatedJob } = await withUserStorageQuota(
      user.id,
      storedImages.reduce((total, stored) => total + stored.byteSize, 0),
      async (tx) => {
        assertGenerationRequestActive(request);
        const assets = await Promise.all(
          storedImages.map((stored) =>
            tx.asset.create({
              data: {
                userId: user.id,
                projectId: projectId || undefined,
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
        assertGenerationRequestActive(request);
        const completed = await completeGenerationJob({
          jobId: job.id,
          model: generation.model,
          provider: generation.provider,
          endpoint: generation.endpoint,
          successCount: assets.length,
          requestedCount: count,
          emptyResultMessage: `${generation.provider} returned no generated images.`,
          client: tx,
        });
        return { createdAssets: assets, updatedJob: completed };
      },
    ).catch(async (error) => {
      await deleteStoredFiles(storedImages.map((stored) => stored.storagePath));
      throw error;
    });

    const response = generationResponse({
      job: updatedJob,
      assets: createdAssets.map(toAssetDTO),
      warnings: [...resolvedModel.warnings, ...generation.warnings],
    });
    await finishSdProgress(runId, "completed");
    telemetry.done(response.status);
    return response;
  } catch (error) {
    if (runId) {
      const canceled =
        request.signal.aborted || (error instanceof ApiError && error.code === "request_aborted");
      await finishSdProgress(runId, canceled ? "canceled" : "failed");
    }
    if (jobId) {
      await failRunningGenerationJob({ jobId, error, fallbackCode: "generation_failed" });
    }

    telemetry.failed(error);
    return jsonError(error);
  } finally {
    await ensureAppState();
  }
}
