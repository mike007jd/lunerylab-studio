import "server-only";

import { ApiError } from "@/lib/server/errors";
import { isImageAssetLike, withAssetWriteTransaction } from "@/lib/server/file-validation";
import { prisma } from "@/lib/server/prisma";
import {
  deleteStoredFile,
  readStoredFile,
  writeFilesOrCleanup,
  writeReferenceFile,
} from "@/lib/server/storage";

export interface ImageReferenceAsset {
  id: string;
  mimeType: string | null;
  storagePath: string;
  width: number | null;
  height: number | null;
}

export async function resolveImageReferenceAssets({
  assetIds,
  userId,
  projectId,
  invalidMessage = "One or more reference assets are missing or are not images.",
  includeInvalidDetails = false,
}: {
  assetIds: string[];
  userId: string;
  projectId?: string | null;
  invalidMessage?: string;
  includeInvalidDetails?: boolean;
}): Promise<ImageReferenceAsset[]> {
  if (assetIds.length === 0) return [];

  const assets = await prisma.asset.findMany({
    where: {
      id: { in: assetIds },
      userId,
      ...(projectId ? { projectId } : {}),
    },
    select: {
      id: true,
      modality: true,
      mimeType: true,
      storagePath: true,
      width: true,
      height: true,
    },
  });

  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const invalidReferenceAssetIds = assetIds.filter((id) => {
    const asset = assetById.get(id);
    return !asset || !isImageAssetLike(asset);
  });

  if (invalidReferenceAssetIds.length > 0) {
    throw new ApiError({
      status: 400,
      code: "invalid_reference_assets",
      message: invalidMessage,
      retryable: false,
      ...(includeInvalidDetails ? { details: { invalidReferenceAssetIds } } : {}),
    });
  }

  return assetIds.map((id) => assetById.get(id)!);
}

export async function loadImageReferenceFiles(
  options: Parameters<typeof resolveImageReferenceAssets>[0],
): Promise<Array<{ asset: ImageReferenceAsset; mimeType: string; bytes: Buffer }>> {
  const assets = await resolveImageReferenceAssets(options);
  return Promise.all(
    assets.map(async (asset) => {
      const stored = await readStoredFile(asset.storagePath);
      return {
        asset,
        mimeType: asset.mimeType || stored.mimeType,
        bytes: Buffer.from(stored.file),
      };
    }),
  );
}

export async function loadRequiredImageReferenceFile({
  assetId,
  userId,
  notFoundMessage = "Reference asset not found.",
}: {
  assetId: string;
  userId: string;
  notFoundMessage?: string;
}): Promise<{ asset: ImageReferenceAsset; mimeType: string; bytes: Buffer }> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId, userId },
    select: {
      id: true,
      modality: true,
      mimeType: true,
      storagePath: true,
      width: true,
      height: true,
    },
  });

  if (!asset) {
    throw new ApiError({
      status: 404,
      code: "asset_not_found",
      message: notFoundMessage,
      retryable: false,
    });
  }

  if (!isImageAssetLike(asset)) {
    throw new ApiError({
      status: 400,
      code: "invalid_reference_asset",
      message: "Reference asset must be an image.",
      retryable: false,
    });
  }

  const stored = await readStoredFile(asset.storagePath);
  return {
    asset,
    mimeType: asset.mimeType || stored.mimeType,
    bytes: Buffer.from(stored.file),
  };
}

async function deleteStoredFiles(storagePaths: string[]): Promise<void> {
  await Promise.allSettled(storagePaths.map((storagePath) => deleteStoredFile(storagePath)));
}

export async function persistUploadedImageReferenceFiles({
  projectId,
  jobId,
  files,
  userId,
}: {
  projectId: string | null;
  jobId: string;
  files: File[];
  userId: string;
}): Promise<Array<{ mimeType: string; bytes: Buffer }>> {
  // All-or-nothing writes: if the 2nd of N reference files fails to write, the
  // already-written ones are deleted instead of orphaned on disk.
  const stored = await writeFilesOrCleanup(files.map((file) => () => writeReferenceFile(file)));

  if (stored.length === 0) return [];

  try {
    await withAssetWriteTransaction((tx) =>
      Promise.all(
        stored.map((file) =>
          tx.asset.create({
            data: {
              userId,
              projectId: projectId || undefined,
              jobId,
              kind: "REFERENCE",
              storagePath: file.storagePath,
              mimeType: file.mimeType,
              byteSize: file.byteSize,
              width: file.width,
              height: file.height,
            },
          }),
        ),
      ),
    );
  } catch (error) {
    // Storage write succeeded but the DB rows didn't — clean up the files.
    await deleteStoredFiles(stored.map((file) => file.storagePath));
    throw error;
  }

  return stored.map((file) => ({
    mimeType: file.mimeType,
    bytes: file.buffer,
  }));
}
