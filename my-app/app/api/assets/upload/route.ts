import { NextRequest, NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/server/errors";
import { assertRequestContentLength, validateFiles, withAssetWriteTransaction } from "@/lib/server/file-validation";
import { getMaxUploadBytesPerFile } from "@/lib/server/env";
import { deleteStoredFile, writeReferenceFile } from "@/lib/server/storage";
import { toAssetDTO } from "@/lib/server/dto";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { resolveOwnedProjectId } from "@/lib/server/project-ownership";
import { parseFormData } from "@/lib/server/http-validation";

export async function POST(request: NextRequest) {
  try {
    const user = await requireLocalWorkspaceOwner();

    assertRequestContentLength(request.headers, getMaxUploadBytesPerFile() + 64 * 1024);
    const formData = await parseFormData(request);

    const file = formData.get("file");
    const projectId = await resolveOwnedProjectId(String(formData.get("projectId") ?? ""), user.id, {
      notFoundMessage: "Provided projectId does not exist.",
    });

    if (!(file instanceof File) || file.size === 0) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "A non-empty file is required.",
        retryable: false,
      });
    }

    await validateFiles([file], { maxFiles: 1 });

    const stored = await writeReferenceFile(file);

    const asset = await withAssetWriteTransaction(async (tx) => {
      // Every asset is attached to a generation job by schema contract.
      // For direct uploads, we persist a local IMPORT job record.
      // so uploaded references remain fully traceable in production audit logs.
      const importJob = await tx.generationJob.create({
        data: {
          userId: user.id,
          projectId: projectId || undefined,
          source: "TOOL",
          toolType: "IMPORT",
          prompt: "",
          referenceCount: 1,
          requestedCount: 1,
          successCount: 1,
          status: "SUCCEEDED",
          provider: "local",
          model: "upload",
          completedAt: new Date(),
        },
      });

      return tx.asset.create({
        data: {
          userId: user.id,
          projectId: projectId || undefined,
          jobId: importJob.id,
          kind: "REFERENCE",
          storagePath: stored.storagePath,
          mimeType: stored.mimeType,
          byteSize: stored.byteSize,
          width: stored.width,
          height: stored.height,
        },
      });
    }).catch(async (error) => {
      await deleteStoredFile(stored.storagePath);
      throw error;
    });

    return NextResponse.json({ asset: toAssetDTO(asset) });
  } catch (error) {
    return jsonError(error);
  }
}
