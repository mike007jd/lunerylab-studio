import "server-only";

import fs from "node:fs/promises";
import { prisma } from "@/lib/server/prisma";
import {
  deleteStoredFile,
  listStoredRelativePaths,
  resolveStoragePath,
} from "@/lib/server/storage";

/**
 * Reconcile the asset database against the files on disk.
 *
 *  - missingFiles: asset rows (active) whose stored file is gone. Reported, not
 *    auto-deleted — bundled sample assets restore their file on read, and
 *    silently dropping rows would destroy history. The UI surfaces these.
 *  - orphanFiles: files under the storage root that no asset row references.
 *    Reported by default; deleted only when deleteOrphans is set (a destructive
 *    action the caller opts into).
 *
 * Local filesystem media only.
 */
export interface StorageReconcileResult {
  supported: boolean;
  missingFiles: string[]; // asset ids whose file is missing
  orphanFiles: string[]; // bucket-relative paths with no owning asset row
  orphansDeleted: number;
}

async function fileExists(storagePath: string): Promise<boolean> {
  try {
    await fs.access(resolveStoragePath(storagePath));
    return true;
  } catch {
    return false;
  }
}

export async function reconcileStorage(
  userId: string,
  options: { deleteOrphans?: boolean } = {},
): Promise<StorageReconcileResult> {
  // Referenced paths span ALL asset rows (active + trashed) so a trashed asset's
  // file is never mistaken for an orphan. Missing-file detection is scoped to the
  // owner's active assets.
  const [activeAssets, allPaths, onDisk] = await Promise.all([
    prisma.asset.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, storagePath: true },
    }),
    prisma.asset.findMany({ select: { storagePath: true } }),
    listStoredRelativePaths(),
  ]);

  const missingFiles: string[] = [];
  await Promise.all(
    activeAssets.map(async (asset) => {
      if (!(await fileExists(asset.storagePath))) missingFiles.push(asset.id);
    }),
  );

  const referenced = new Set(allPaths.map((a) => a.storagePath));
  const orphanFiles = onDisk.filter((p) => !referenced.has(p));

  let orphansDeleted = 0;
  if (options.deleteOrphans) {
    await Promise.all(
      orphanFiles.map(async (p) => {
        try {
          await deleteStoredFile(p);
          orphansDeleted += 1;
        } catch {
          // Leave undeletable orphans for the next run.
        }
      }),
    );
  }

  return { supported: true, missingFiles, orphanFiles, orphansDeleted };
}
