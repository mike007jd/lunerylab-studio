import "server-only";

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/server/prisma";
import { luneryLogDir, luneryModelsDir, luneryProfileRoot } from "@/lib/server/lunery-profile";

/**
 * Local storage breakdown so a user can see where their disk goes and understand
 * that Trash still occupies space until purged.
 *
 * - active/trash: summed from asset rows (byteSize), split by soft-delete state.
 * - models/logs: on-disk footprint of the profile's models/ and logs/ dirs.
 * - freeDisk: bytes still available on the volume holding the profile.
 *
 * Every filesystem read is best-effort: a missing dir or an unsupported statfs
 * yields 0 / null instead of failing the whole call (web mode has no profile).
 */
export interface StorageBreakdown {
  activeBytes: number;
  trashBytes: number;
  modelsBytes: number;
  logsBytes: number;
  freeDiskBytes: number | null;
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // missing/unreadable dir contributes nothing.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(full);
        total += stat.size;
      } catch {
        // File vanished between readdir and stat — skip it.
      }
    }
  }
  return total;
}

async function freeDiskBytes(): Promise<number | null> {
  try {
    const stats = await fs.statfs(luneryProfileRoot());
    // bavail = blocks available to an unprivileged user.
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export async function getStorageBreakdown(userId: string): Promise<StorageBreakdown> {
  const [active, trash, modelsBytes, logsBytes, freeDisk] = await Promise.all([
    prisma.asset.aggregate({
      where: { userId, deletedAt: null },
      _sum: { byteSize: true },
    }),
    prisma.asset.aggregate({
      where: { userId, deletedAt: { not: null } },
      _sum: { byteSize: true },
    }),
    // Models live under the profile; media (active/trash) is already counted via
    // asset rows, so we size models/ and logs/ directly.
    dirSizeBytes(luneryModelsDir()),
    dirSizeBytes(luneryLogDir()),
    freeDiskBytes(),
  ]);

  // The media dir is intentionally NOT sized on disk here — asset byteSize
  // already accounts for generated/uploaded media, and summing both would
  // double-count.
  return {
    activeBytes: active._sum.byteSize ?? 0,
    trashBytes: trash._sum.byteSize ?? 0,
    modelsBytes,
    logsBytes,
    freeDiskBytes: freeDisk,
  };
}
