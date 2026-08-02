import "server-only";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { luneryRuntimeDir } from "@/lib/server/lunery-profile";
import {
  nativeProfileRename,
  nativeProfileUnlink,
  nativeProfileWrite,
} from "@/lib/server/native-profile-fs";

const REVISION_FILE_NAME = "provider-status.revision";

function revisionFilePath(): string {
  return path.join(luneryRuntimeDir(), REVISION_FILE_NAME);
}

/**
 * Returns null when the marker cannot be read. Callers treat that as
 * uncacheable so a profile filesystem problem never freezes provider state.
 */
export function readDesktopStatusRevision(): string | null {
  try {
    return readFileSync(revisionFilePath(), "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    return null;
  }
}

/**
 * Cross-bundle cache invalidation for Next route workers. The marker lives in
 * the visible profile runtime directory, and atomic rename prevents readers
 * from observing a partially-written revision.
 */
export async function bumpDesktopStatusRevision(): Promise<string> {
  const filePath = revisionFilePath();
  const revision = randomUUID();
  const temporaryName = `${REVISION_FILE_NAME}.${process.pid}.${revision}.tmp`;
  try {
    await nativeProfileWrite("runtime", temporaryName, Buffer.from(revision, "utf8"), {
      replace: false,
    });
    await nativeProfileRename("runtime", temporaryName, path.basename(filePath), {
      replace: true,
    });
  } finally {
    await nativeProfileUnlink("runtime", temporaryName, { missingOk: true });
  }
  return revision;
}
