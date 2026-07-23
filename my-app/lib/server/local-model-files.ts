import "server-only";

import { promises as fs } from "node:fs";
import { type HfModelEntry } from "@/lib/hf-model-catalog";
import { modelCachePath } from "@/lib/server/imported-model-registry";

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
