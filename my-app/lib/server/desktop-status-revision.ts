import "server-only";

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { luneryRuntimeDir } from "@/lib/server/lunery-profile";

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
export function bumpDesktopStatusRevision(): string {
  const filePath = revisionFilePath();
  const revision = randomUUID();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${revision}.tmp`;
  try {
    writeFileSync(temporaryPath, revision, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return revision;
}
