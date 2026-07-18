import { NextRequest, NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/server/errors";
import {
  assertRequestContentLength,
  validateFiles,
  withUserStorageQuota,
} from "@/lib/server/file-validation";
import { getMaxUploadBytesPerFile } from "@/lib/server/env";
import { parseFormData } from "@/lib/server/http-validation";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { requireWritableCanvasSession } from "@/lib/server/canvas-session-access";
import { PLATFORM_SIZES_BY_ID } from "@/lib/constants/platform-sizes";
import { exportForPlatforms } from "@/lib/server/platform-export";
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
import { toAssetDTO } from "@/lib/server/dto";

interface Params {
  params: Promise<{ id: string }>;
}

const PNG_ONLY = new Set(["image/png"]);
const MAX_PLATFORM_EXPORTS = 12;

export async function POST(request: NextRequest, { params }: Params) {
  let jobId: string | null = null;
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;
    const session = await requireWritableCanvasSession(id, user.id);
    assertRequestContentLength(request.headers, getMaxUploadBytesPerFile() + 128 * 1024);

    const formData = await parseFormData(request);
    const source = formData.get("source");
    if (!(source instanceof File) || source.size === 0) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "A non-empty canvas PNG is required.",
        retryable: false,
      });
    }
    await validateFiles([source], { maxFiles: 1, allowedMimeTypes: PNG_ONLY });

    const mode = formData.get("mode") === "platforms" ? "platforms" : "original";
    const presetIds = [...new Set(
      formData
        .getAll("presetIds")
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    )];
    if (mode === "platforms" && (presetIds.length === 0 || presetIds.length > MAX_PLATFORM_EXPORTS)) {
      throw new ApiError({
        status: 400,
        code: "invalid_platform_exports",
        message: `Choose between 1 and ${MAX_PLATFORM_EXPORTS} platform sizes.`,
        retryable: false,
      });
    }
    const invalidPresetIds = presetIds.filter((presetId) => !PLATFORM_SIZES_BY_ID[presetId]);
    if (invalidPresetIds.length > 0) {
      throw new ApiError({
        status: 400,
        code: "invalid_platform_exports",
        message: `Unknown platform size: ${invalidPresetIds.join(", ")}.`,
        retryable: false,
      });
    }

    const sourceBytes = Buffer.from(await source.arrayBuffer());
    const outputs = mode === "original"
      ? [{
          presetId: "original",
          bytes: sourceBytes,
          mimeType: "image/png" as const,
          width: 0,
          height: 0,
        }]
      : await exportForPlatforms(sourceBytes, presetIds, { fit: "cover" });

    const job = await createGenerationJob({
      userId: user.id,
      projectId: session.projectId,
      source: "STUDIO",
      toolType: "extender",
      prompt: mode === "original" ? "Canvas export: original PNG" : `Canvas export: ${presetIds.join(", ")}`,
      referenceCount: 0,
      requestedCount: outputs.length,
      provider: "canvas-export",
      model: "sharp",
    });
    jobId = job.id;

    const storedOutputs = await writeFilesOrCleanup(
      outputs.map((output) => () => writeGeneratedImage({
        bytes: output.bytes,
        projectId: session.projectId,
      })),
    );
    const createdAssets = await withUserStorageQuota(
      user.id,
      storedOutputs.reduce((total, stored) => total + stored.byteSize, 0),
      async (tx) => {
        const assets = await Promise.all(storedOutputs.map((stored, index) => tx.asset.create({
          data: {
            userId: user.id,
            projectId: session.projectId,
            jobId: job.id,
            kind: "GENERATED",
            storagePath: stored.storagePath,
            mimeType: stored.mimeType,
            byteSize: stored.byteSize,
            width: stored.width,
            height: stored.height,
            summary: outputs[index]?.presetId === "original"
              ? "Canvas export · original size"
              : `Canvas export · ${outputs[index]?.presetId ?? "platform"}`,
          },
        })));
        await completeGenerationJob({
          jobId: job.id,
          model: "sharp",
          provider: "canvas-export",
          successCount: assets.length,
          requestedCount: outputs.length,
          client: tx,
        });
        return assets;
      },
    ).catch(async (error) => {
      await Promise.allSettled(storedOutputs.map((stored) => deleteStoredFile(stored.storagePath)));
      throw error;
    });

    return NextResponse.json({
      exports: createdAssets.map((asset, index) => {
        const output = outputs[index]!;
        const extension = asset.mimeType === "image/jpeg"
          ? "jpg"
          : asset.mimeType === "image/webp"
            ? "webp"
            : "png";
        return {
          ...toAssetDTO(asset),
          presetId: output.presetId,
          downloadName: `lunery-canvas-${output.presetId}.${extension}`,
        };
      }),
    });
  } catch (error) {
    if (jobId) {
      await failRunningGenerationJob({ jobId, error, fallbackCode: "canvas_export_error" });
    }
    return jsonError(error);
  }
}
