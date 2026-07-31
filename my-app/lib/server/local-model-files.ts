import "server-only";

import path from "node:path";
import { promises as fs } from "node:fs";
import { type HfModelEntry } from "@/lib/hf-model-catalog";
import { modelCachePath, modelsCacheRoot } from "@/lib/server/imported-model-registry";

export interface LocalModelFileStatus {
  fileName: string;
  installed: boolean;
  partial: boolean;
  bytes: number;
  expectedBytes: number;
}

export async function modelFileExists(filePath: string): Promise<{ exists: boolean; bytes: number }> {
  try {
    const stat = await fs.stat(filePath);
    return { exists: stat.isFile(), bytes: stat.isFile() ? stat.size : 0 };
  } catch {
    return { exists: false, bytes: 0 };
  }
}

export function catalogModelFiles(entry: HfModelEntry): Array<{ fileName: string; expectedBytes: number }> {
  const companions = entry.companions ?? [];
  return [
    {
      fileName: entry.fileName || entry.id,
      expectedBytes:
        companions.length > 0
          ? Math.max(
              0,
              entry.sizeBytes - companions.reduce((sum, file) => sum + file.sizeBytes, 0),
            )
          : entry.sizeBytes,
    },
    ...companions.map((file) => ({
      fileName: file.fileName,
      expectedBytes: file.sizeBytes,
    })),
  ];
}

export async function catalogModelFileStatuses(entry: HfModelEntry): Promise<LocalModelFileStatus[]> {
  return Promise.all(
    catalogModelFiles(entry).map(async (file) => {
      const dest = modelCachePath(entry.runtimeTarget, file.fileName);
      const [complete, partial] = await Promise.all([
        modelFileExists(dest),
        modelFileExists(`${dest}.part`),
      ]);

      return {
        fileName: file.fileName,
        installed: complete.exists,
        partial: partial.exists,
        bytes: complete.exists ? complete.bytes : partial.bytes,
        expectedBytes: file.expectedBytes,
      };
    }),
  );
}

export async function catalogModelInstalled(entry: HfModelEntry): Promise<boolean> {
  const statuses = await catalogModelFileStatuses(entry);
  return statuses.length > 0 && statuses.every((file) => file.installed);
}

function isPathInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isManagedModelCachePath(filePath: string): boolean {
  return isPathInsideRoot(modelsCacheRoot(), filePath);
}

async function realModelCacheRoot(): Promise<string> {
  try {
    return await fs.realpath(modelsCacheRoot());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return path.resolve(modelsCacheRoot());
    }
    throw error;
  }
}

/** Remove only regular files/symlinks under the profile model cache. */
export async function removeManagedModelFiles(filePaths: readonly string[]): Promise<number> {
  const uniquePaths = [...new Set(filePaths)];
  const existingFiles: string[] = [];
  const cacheRoot = await realModelCacheRoot();

  for (const filePath of uniquePaths) {
    if (!isManagedModelCachePath(filePath)) {
      throw new Error("Model file is outside the managed model cache.");
    }

    let stat;
    try {
      stat = await fs.lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    if (stat.isDirectory()) {
      throw new Error("Refusing to remove a model directory as a file.");
    }

    const parent = path.dirname(filePath);
    let parentRealPath: string;
    try {
      parentRealPath = await fs.realpath(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!isPathInsideRoot(cacheRoot, parentRealPath)) {
      throw new Error("Model file parent is outside the managed model cache.");
    }

    existingFiles.push(filePath);
  }

  for (const filePath of existingFiles) {
    await fs.unlink(filePath);
  }
  return existingFiles.length;
}
