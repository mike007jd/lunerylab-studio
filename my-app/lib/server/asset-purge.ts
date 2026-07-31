import "server-only";

import { ApiError } from "@/lib/server/errors";
import { prisma } from "@/lib/server/prisma";
import { deleteStoredFile } from "@/lib/server/storage";

/**
 * Permanently remove assets: delete the database rows and the underlying stored
 * files (freeing disk), and reconcile any ReferenceSet that pointed at them.
 *
 * Soft delete (deletedAt) only hides an asset; the file still occupies disk.
 * This is the path that actually reclaims storage. It is deliberately the ONLY
 * place that hard-deletes asset media.
 *
 * Safety:
 *   - Scoped to a single userId — never touches another owner's rows.
 *   - A stored file is unlinked only when no OTHER surviving asset references the
 *     same storagePath, so shared/bundled media is never removed out from under
 *     a still-live asset.
 *   - Stored files are deleted before rows. A failed unlink keeps the asset rows
 *     as the retry record instead of reporting a permanent delete that left
 *     local data behind. Missing files are already idempotent in deleteStoredFile.
 *   - Rows are removed in a single deleteMany; their ReferenceSetAsset
 *     memberships cascade away via FK.
 */
export interface AssetPurgeResult {
  purgedCount: number;
  bytesFreed: number;
  filesDeleted: number;
}

type PurgeTarget = "trash" | string[];

export async function purgeAssets(userId: string, target: PurgeTarget): Promise<AssetPurgeResult> {
  const where =
    target === "trash"
      ? { userId, deletedAt: { not: null } }
      : { userId, id: { in: target } };

  const targets = await prisma.asset.findMany({
    where,
    select: { id: true, storagePath: true, byteSize: true },
  });

  if (targets.length === 0) {
    return { purgedCount: 0, bytesFreed: 0, filesDeleted: 0 };
  }

  const purgedIds = targets.map((a) => a.id);
  const candidatePaths = [...new Set(targets.map((a) => a.storagePath))];
  const bytesByPath = new Map<string, number>();
  for (const target of targets) {
    bytesByPath.set(
      target.storagePath,
      Math.max(bytesByPath.get(target.storagePath) ?? 0, target.byteSize ?? 0),
    );
  }

  // Paths still referenced by a surviving (non-purged) asset must NOT be
  // unlinked — another live asset shares that file.
  const survivorsUsingPaths = await prisma.asset.findMany({
    where: { storagePath: { in: candidatePaths }, id: { notIn: purgedIds } },
    select: { storagePath: true },
  });
  const sharedPaths = new Set(survivorsUsingPaths.map((a) => a.storagePath));
  const pathsToDelete = candidatePaths.filter((p) => !sharedPaths.has(p));
  const bytesFreed = pathsToDelete.reduce(
    (sum, storagePath) => sum + (bytesByPath.get(storagePath) ?? 0),
    0,
  );

  let filesDeleted = 0;
  for (const storagePath of pathsToDelete) {
    try {
      await deleteStoredFile(storagePath);
      filesDeleted += 1;
    } catch {
      throw new ApiError({
        status: 503,
        code: "asset_file_delete_failed",
        message: "Could not delete all local asset files. Please try again.",
        retryable: true,
      });
    }
  }

  // Deleting the asset rows also removes their ReferenceSetAsset memberships via
  // the join table's onDelete: Cascade FK — no dangling reference ids survive.
  // If this step fails, the rows retain the storage paths needed for an
  // idempotent retry; files already removed resolve as success on the next run.
  try {
    await prisma.asset.deleteMany({ where: { id: { in: purgedIds }, userId } });
  } catch {
    throw new ApiError({
      status: 503,
      code: "asset_record_delete_failed",
      message: "Local files were deleted, but their records could not be removed. Please try again.",
      retryable: true,
    });
  }

  return { purgedCount: targets.length, bytesFreed, filesDeleted };
}
