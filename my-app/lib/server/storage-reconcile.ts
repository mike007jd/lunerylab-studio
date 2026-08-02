import "server-only";

import { prisma } from "@/lib/server/prisma";
import {
  deleteStoredFile,
  getStoredFileMetadata,
  listStoredRelativePaths,
} from "@/lib/server/storage";
import { withWorkspaceExclusive } from "@/lib/server/workspace-operation-gate";

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
    // Use the same canonical, final-component no-follow path as media reads.
    // fs.access(resolveStoragePath(...)) would follow a raced symlink.
    await getStoredFileMetadata(storagePath);
    return true;
  } catch {
    return false;
  }
}

async function reconcileStorageSnapshot(
  userId: string,
  options: { deleteOrphans?: boolean },
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
    for (const orphanPath of orphanFiles) {
      try {
        // Re-check ownership under exclusive admission before unlink so a
        // writer that committed between the snapshot and deletion cannot lose
        // its file.
        const owned = await prisma.asset.findFirst({
          where: { storagePath: orphanPath },
          select: { id: true },
        });
        if (owned) continue;
        await deleteStoredFile(orphanPath);
        orphansDeleted += 1;
      } catch {
        // Leave undeletable orphans for the next run.
      }
    }
  }

  return { supported: true, missingFiles, orphanFiles, orphansDeleted };
}

export async function reconcileStorage(
  userId: string,
  options: { deleteOrphans?: boolean } = {},
): Promise<StorageReconcileResult> {
  if (options.deleteOrphans) {
    return withWorkspaceExclusive("destructive-reconcile", () =>
      reconcileStorageSnapshot(userId, { deleteOrphans: true }),
    );
  }
  return reconcileStorageSnapshot(userId, { deleteOrphans: false });
}
