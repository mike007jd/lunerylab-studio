import "server-only";

import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { type HfModelEntry } from "@/lib/hf-model-catalog";
import { modelCachePath, modelsCacheRoot } from "@/lib/server/imported-model-registry";
import { withSharedMutationLease } from "@/lib/server/workspace-operation-gate";

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

interface ModelPathIdentity {
  device: bigint;
  inode: bigint;
}

interface ManagedFileGuard {
  directories: Array<{ absolutePath: string; identity: ModelPathIdentity }>;
  fileIdentity: ModelPathIdentity;
  rootReal: string;
}

export interface StagedManagedModelFile {
  originalPath: string;
  stagedPath: string;
}

interface ManagedModelCleanupJournal {
  version: 1;
  stages: StagedManagedModelFile[];
}

export class ManagedModelCleanupPendingError extends Error {
  constructor(
    readonly removedFiles: number,
    readonly pendingPaths: string[],
  ) {
    super("Managed model deletion committed, but staged file cleanup is pending.");
    this.name = "ManagedModelCleanupPendingError";
  }
}

export const __localModelFilesTestHooks = {
  beforeMutation: null as null | ((filePath: string) => Promise<void> | void),
};

function modelPathIdentity(metadata: import("node:fs").BigIntStats): ModelPathIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function sameModelPathIdentity(left: ModelPathIdentity, right: ModelPathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function captureManagedFileGuard(filePath: string): Promise<ManagedFileGuard | null> {
  const root = path.resolve(modelsCacheRoot());
  if (!isPathInsideRoot(root, filePath)) {
    throw new Error("Model file is outside the managed model cache.");
  }

  let rootMetadata: import("node:fs").BigIntStats;
  try {
    rootMetadata = await fs.lstat(root, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Managed model cache root must be a real directory.");
  }
  const rootReal = await fs.realpath(root);
  const relativeParent = path.relative(root, path.dirname(filePath));
  const parentSegments = relativeParent === "" ? [] : relativeParent.split(path.sep);
  const directoryPaths = [root];
  let current = root;
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    directoryPaths.push(current);
  }
  const directories: ManagedFileGuard["directories"] = [];
  for (const directoryPath of directoryPaths) {
    let metadata: import("node:fs").BigIntStats;
    try {
      metadata = await fs.lstat(directoryPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Managed model cache path contains a symlink.");
    }
    if (!isPathInsideRoot(rootReal, await fs.realpath(directoryPath)) && directoryPath !== root) {
      throw new Error("Model file parent is outside the managed model cache.");
    }
    directories.push({ absolutePath: directoryPath, identity: modelPathIdentity(metadata) });
  }

  let fileMetadata: import("node:fs").BigIntStats;
  try {
    fileMetadata = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (fileMetadata.isDirectory()) {
    throw new Error("Refusing to remove a model directory as a file.");
  }
  return {
    directories,
    fileIdentity: modelPathIdentity(fileMetadata),
    rootReal,
  };
}

async function verifyManagedDirectories(guard: ManagedFileGuard): Promise<void> {
  for (const expected of guard.directories) {
    const current = await fs.lstat(expected.absolutePath, { bigint: true });
    if (
      current.isSymbolicLink()
      || !current.isDirectory()
      || !sameModelPathIdentity(expected.identity, modelPathIdentity(current))
    ) {
      throw new Error("Managed model cache path changed during deletion.");
    }
    if (
      expected.absolutePath !== guard.directories[0]!.absolutePath
      && !isPathInsideRoot(guard.rootReal, await fs.realpath(expected.absolutePath))
    ) {
      throw new Error("Model file parent is outside the managed model cache.");
    }
  }
}

async function guardedRenameManagedFile(
  sourcePath: string,
  destinationPath: string,
  runTestHook: boolean,
): Promise<boolean> {
  if (path.dirname(sourcePath) !== path.dirname(destinationPath)) {
    throw new Error("Managed model staging must remain in the source directory.");
  }
  const guard = await captureManagedFileGuard(sourcePath);
  if (!guard) return false;
  if (runTestHook && process.env.NODE_ENV === "test" && __localModelFilesTestHooks.beforeMutation) {
    await __localModelFilesTestHooks.beforeMutation(sourcePath);
  }
  // Validate after the deterministic race hook and once more immediately
  // before rename. Node has no renameat(2); this prevents every detected swap
  // from moving an external file and leaves only the unavoidable external
  // actor race between the final check and the syscall.
  await verifyManagedDirectories(guard);
  try {
    await fs.lstat(destinationPath);
    throw new Error("Managed model staging path already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await verifyManagedDirectories(guard);
  await fs.rename(sourcePath, destinationPath);
  await verifyManagedDirectories(guard);
  const staged = await fs.lstat(destinationPath, { bigint: true });
  if (!sameModelPathIdentity(guard.fileIdentity, modelPathIdentity(staged))) {
    throw new Error("Managed model file changed during staging.");
  }
  return true;
}

/** Stage managed files with same-directory renames before metadata commits. */
export async function stageManagedModelFiles(
  filePaths: readonly string[],
): Promise<StagedManagedModelFile[]> {
  const uniquePaths = [...new Set(filePaths)];
  const staged: StagedManagedModelFile[] = [];
  try {
    for (const filePath of uniquePaths) {
      if (!isManagedModelCachePath(filePath)) {
        throw new Error("Model file is outside the managed model cache.");
      }
      const stage = {
        originalPath: filePath,
        stagedPath: `${filePath}.${randomUUID()}.lunery-delete`,
      };
      if (await guardedRenameManagedFile(stage.originalPath, stage.stagedPath, true)) {
        staged.push(stage);
      }
    }
    return staged;
  } catch (error) {
    try {
      await rollbackManagedModelFiles(staged);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Managed model staging failed and could not be fully rolled back.",
      );
    }
    throw error;
  }
}

export async function rollbackManagedModelFiles(
  stagedFiles: readonly StagedManagedModelFile[],
): Promise<void> {
  for (const stage of [...stagedFiles].reverse()) {
    await guardedRenameManagedFile(stage.stagedPath, stage.originalPath, false);
  }
}

export async function commitManagedModelFiles(
  stagedFiles: readonly StagedManagedModelFile[],
): Promise<number> {
  let removed = 0;
  const pendingPaths: string[] = [];
  for (const stage of stagedFiles) {
    try {
      const guard = await captureManagedFileGuard(stage.stagedPath);
      if (!guard) continue;
      if (process.env.NODE_ENV === "test" && __localModelFilesTestHooks.beforeMutation) {
        await __localModelFilesTestHooks.beforeMutation(stage.stagedPath);
      }
      await verifyManagedDirectories(guard);
      await fs.unlink(stage.stagedPath);
      await verifyManagedDirectories(guard);
      removed += 1;
    } catch {
      pendingPaths.push(stage.stagedPath);
    }
  }
  if (pendingPaths.length > 0) {
    throw new ManagedModelCleanupPendingError(removed, pendingPaths);
  }
  return removed;
}

function managedCleanupJournalDir(): string {
  return path.join(modelsCacheRoot(), ".managed-delete-journal");
}

function validateCleanupStages(value: unknown): StagedManagedModelFile[] {
  if (!Array.isArray(value)) throw new Error("Corrupt managed model cleanup journal.");
  return value.map((stage) => {
    if (
      !stage
      || typeof stage !== "object"
      || typeof (stage as StagedManagedModelFile).originalPath !== "string"
      || typeof (stage as StagedManagedModelFile).stagedPath !== "string"
    ) {
      throw new Error("Corrupt managed model cleanup journal.");
    }
    const candidate = stage as StagedManagedModelFile;
    if (
      !isManagedModelCachePath(candidate.originalPath)
      || !isManagedModelCachePath(candidate.stagedPath)
      || path.dirname(candidate.originalPath) !== path.dirname(candidate.stagedPath)
      || !candidate.stagedPath.endsWith(".lunery-delete")
    ) {
      throw new Error("Hostile managed model cleanup journal path.");
    }
    return { originalPath: candidate.originalPath, stagedPath: candidate.stagedPath };
  });
}

async function writeManagedCleanupJournal(
  stagedFiles: readonly StagedManagedModelFile[],
): Promise<string> {
  const directory = managedCleanupJournalDir();
  await fs.mkdir(directory, { recursive: true });
  const journalPath = path.join(directory, `${randomUUID()}.json`);
  const tempPath = `${journalPath}.tmp`;
  const payload: ManagedModelCleanupJournal = {
    version: 1,
    stages: validateCleanupStages([...stagedFiles]),
  };
  const handle = await fs.open(tempPath, "wx");
  try {
    await handle.writeFile(JSON.stringify(payload), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, journalPath);
  return journalPath;
}

async function readManagedCleanupJournal(journalPath: string): Promise<StagedManagedModelFile[]> {
  const parsed = JSON.parse(await fs.readFile(journalPath, "utf8")) as {
    version?: unknown;
    stages?: unknown;
  };
  if (parsed.version !== 1) throw new Error("Corrupt managed model cleanup journal.");
  return validateCleanupStages(parsed.stages);
}

/**
 * Metadata/registry success is the logical delete commit point. Publish a
 * durable cleanup plan before unlinking staged bytes so a cleanup error can be
 * reported as successful-with-pending-work and retried on startup.
 */
export async function finalizeManagedModelFiles(
  stagedFiles: readonly StagedManagedModelFile[],
): Promise<number> {
  if (stagedFiles.length === 0) return 0;
  const journalPath = await writeManagedCleanupJournal(stagedFiles);
  try {
    const removed = await commitManagedModelFiles(stagedFiles);
    await fs.unlink(journalPath);
    return removed;
  } catch (error) {
    // Keep the durable plan. Startup reconciliation retries only paths named by
    // a committed journal; uncommitted stage/rollback residue is never deleted.
    throw error;
  }
}

async function listManagedCleanupJournals(): Promise<string[]> {
  const directory = managedCleanupJournalDir();
  let entries: import("node:fs").Dirent[];
  try {
    const metadata = await fs.lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Managed model cleanup journal directory must be real.");
    }
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name));
}

/** Retry cleanup left after metadata reached the logical delete commit point. */
export async function reconcileStagedManagedModelFiles(): Promise<number> {
  return withSharedMutationLease(async () => {
    let removed = 0;
    for (const journalPath of await listManagedCleanupJournals()) {
      const stages = await readManagedCleanupJournal(journalPath);
      removed += await commitManagedModelFiles(stages);
      await fs.unlink(journalPath);
    }
    return removed;
  });
}

/** Compatibility helper for callers that do not have metadata to coordinate. */
export async function removeManagedModelFiles(filePaths: readonly string[]): Promise<number> {
  const staged = await stageManagedModelFiles(filePaths);
  return commitManagedModelFiles(staged);
}
