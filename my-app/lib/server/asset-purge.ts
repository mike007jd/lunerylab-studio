import "server-only";

import { ApiError } from "@/lib/server/errors";
import { prisma } from "@/lib/server/prisma";
import {
  commitStoredFileDeletion,
  rollbackStoredFileDeletion,
  stageStoredFileDeletion,
  type StagedStoredFileDeletion,
} from "@/lib/server/storage";
import { withSharedMutationLease } from "@/lib/server/workspace-operation-gate";

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
 *   - Files are first renamed to same-volume quarantine paths. A staging or DB
 *     failure restores them before returning, without changing asset visibility.
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
  return withSharedMutationLease(async () => {
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

  const stages: StagedStoredFileDeletion[] = [];
  try {
    for (const storagePath of pathsToDelete) {
      stages.push(await stageStoredFileDeletion(storagePath));
    }
  } catch {
    await Promise.allSettled(stages.map((stage) => rollbackStoredFileDeletion(stage)));
    throw new ApiError({
      status: 503,
      code: "asset_file_delete_failed",
      message: "Could not stage all local asset files for deletion. Please try again.",
      retryable: true,
    });
  }

  // Deleting the asset rows also removes their ReferenceSetAsset memberships via
  // the join table's onDelete: Cascade FK — no dangling reference ids survive.
  try {
    await prisma.asset.deleteMany({ where: { id: { in: purgedIds }, userId } });
  } catch {
    const rollback = await Promise.allSettled(
      stages.map((stage) => rollbackStoredFileDeletion(stage)),
    );
    const rollbackFailed = rollback.some((result) => result.status === "rejected");
    throw new ApiError({
      status: 503,
      code: "asset_record_delete_failed",
      message: rollbackFailed
        ? "Asset records could not be removed and file rollback needs another retry."
        : "Asset records could not be removed. Local files were restored; please try again.",
      retryable: true,
    });
  }

  try {
    for (const stage of stages) await commitStoredFileDeletion(stage);
  } catch {
    // Rows are already gone. The deterministic quarantine path is reconciled
    // on the next desktop bootstrap, so never pretend disk cleanup completed.
    throw new ApiError({
      status: 503,
      code: "asset_file_delete_failed",
      message: "Asset records were removed, but staged files still need cleanup. Please restart Studio.",
      retryable: true,
    });
  }

  const filesDeleted = stages.filter((stage) => stage.hadFile).length;
  const bytesFreed = stages.reduce(
    (sum, stage) => sum + (stage.hadFile ? (bytesByPath.get(stage.storagePath) ?? 0) : 0),
    0,
  );

  return { purgedCount: targets.length, bytesFreed, filesDeleted };
  });
}
