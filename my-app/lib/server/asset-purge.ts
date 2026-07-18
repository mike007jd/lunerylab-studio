import "server-only";

import { prisma } from "@/lib/server/prisma";
import { deleteStoredFile } from "@/lib/server/storage";

/**
 * Permanently remove assets: delete the database rows (freeing quota) and the
 * underlying stored files (freeing disk), and reconcile any ReferenceSet that
 * pointed at them.
 *
 * Soft delete (deletedAt) only hides an asset; the row still counts toward quota
 * and the file still occupies disk. This is the path that actually reclaims
 * both. It is deliberately the ONLY place that hard-deletes asset media.
 *
 * Safety:
 *   - Scoped to a single userId — never touches another owner's rows.
 *   - A stored file is unlinked only when no OTHER surviving asset references the
 *     same storagePath, so shared/bundled media is never removed out from under
 *     a still-live asset.
 *   - Rows are removed in a single deleteMany (quota freed atomically); their
 *     ReferenceSetAsset memberships cascade away via FK. File deletion runs after
 *     and is best-effort (a failed unlink leaves a reconcilable orphan, never a
 *     dangling DB row).
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
  const bytesFreed = targets.reduce((sum, a) => sum + (a.byteSize ?? 0), 0);
  const candidatePaths = [...new Set(targets.map((a) => a.storagePath))];

  // Paths still referenced by a surviving (non-purged) asset must NOT be
  // unlinked — another live asset shares that file.
  const survivorsUsingPaths = await prisma.asset.findMany({
    where: { storagePath: { in: candidatePaths }, id: { notIn: purgedIds } },
    select: { storagePath: true },
  });
  const sharedPaths = new Set(survivorsUsingPaths.map((a) => a.storagePath));
  const pathsToDelete = candidatePaths.filter((p) => !sharedPaths.has(p));

  // Deleting the asset rows also removes their ReferenceSetAsset memberships via
  // the join table's onDelete: Cascade FK — no dangling reference ids survive.
  await prisma.asset.deleteMany({ where: { id: { in: purgedIds }, userId } });

  let filesDeleted = 0;
  await Promise.all(
    pathsToDelete.map(async (storagePath) => {
      try {
        await deleteStoredFile(storagePath);
        filesDeleted += 1;
      } catch {
        // Best-effort: a failed unlink leaves a reconcilable orphan file, not a
        // dangling DB row. The orphan reconciler (T-M4-5) sweeps these.
      }
    }),
  );

  return { purgedCount: targets.length, bytesFreed, filesDeleted };
}
