import "server-only";

import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { type HfModelEntry } from "@/lib/hf-model-catalog";
import {
  isImportedModelRecord,
  modelCachePath,
  modelsCacheRoot,
  upsertImportedModel,
  type ImportedModelRecord,
} from "@/lib/server/imported-model-registry";
import { prisma } from "@/lib/server/prisma";
import { withSharedMutationLease } from "@/lib/server/workspace-operation-gate";
import {
  nativeProfileMkdir,
  nativeProfileRename,
  nativeProfileUnlink,
  nativeProfileWrite,
  profileRelativePath,
} from "@/lib/server/native-profile-fs";

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

export interface StagedManagedModelFile {
  originalPath: string;
  stagedPath: string;
  journalPath?: string;
}

interface ManagedModelCleanupJournal {
  version: 2;
  stages: StagedManagedModelFile[];
  recovery?: ManagedModelDeletionRecovery;
}

export interface ManagedModelDeletionRecovery {
  ownerId: string;
  modelId: string;
  importedModel?: ImportedModelRecord;
  defaults: {
    cleared: Array<"text" | "image">;
    previous: {
      defaultTextModel: string;
      defaultImageModel: string;
    };
  };
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
  afterPreparedJournal: null as null | ((journalPath: string) => Promise<void> | void),
  afterStage: null as null | ((stage: StagedManagedModelFile) => Promise<void> | void),
  beforeRecoveryJournalReplace: null as null | ((tempPath: string) => Promise<void> | void),
  afterRecoveryJournal: null as null | ((journalPath: string) => Promise<void> | void),
  afterCommittedMarker: null as null | ((journalPath: string) => Promise<void> | void),
};

export class SimulatedManagedModelCrashError extends Error {
  constructor() {
    super("Simulated managed-model process crash.");
    this.name = "SimulatedManagedModelCrashError";
  }
}

const journalPaths = new WeakMap<object, string>();

function journalPathFor(stagedFiles: readonly StagedManagedModelFile[]): string | null {
  return journalPaths.get(stagedFiles as object)
    ?? stagedFiles.find((stage) => stage.journalPath)?.journalPath
    ?? null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    const metadata = await fs.lstat(filePath);
    if (metadata.isDirectory()) {
      throw new Error("Refusing to mutate a model directory as a file.");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function stageWithJournal(
  stage: StagedManagedModelFile,
  journalPath: string,
): StagedManagedModelFile {
  return { ...stage, journalPath };
}

async function guardedRenameManagedFile(
  sourcePath: string,
  destinationPath: string,
  runTestHook: boolean,
): Promise<boolean> {
  if (path.dirname(sourcePath) !== path.dirname(destinationPath)) {
    throw new Error("Managed model staging must remain in the source directory.");
  }
  if (!isManagedModelCachePath(sourcePath) || !isManagedModelCachePath(destinationPath)) {
    throw new Error("Model file is outside the managed model cache.");
  }
  if (!(await pathExists(sourcePath))) return false;
  if (runTestHook && process.env.NODE_ENV === "test" && __localModelFilesTestHooks.beforeMutation) {
    await __localModelFilesTestHooks.beforeMutation(sourcePath);
  }
  await nativeProfileRename(
    "models",
    profileRelativePath("models", sourcePath),
    profileRelativePath("models", destinationPath),
  );
  return true;
}

/** Stage managed files with same-directory renames before metadata commits. */
export async function stageManagedModelFiles(
  filePaths: readonly string[],
): Promise<StagedManagedModelFile[]> {
  const uniquePaths = [...new Set(filePaths)];
  const plans: StagedManagedModelFile[] = [];
  for (const filePath of uniquePaths) {
    if (!isManagedModelCachePath(filePath)) {
      throw new Error("Model file is outside the managed model cache.");
    }
    if (await pathExists(filePath)) {
      plans.push({
        originalPath: filePath,
        stagedPath: `${filePath}.${randomUUID()}.lunery-delete`,
      });
    }
  }
  if (plans.length === 0) return [];
  const journalPath = await writeManagedCleanupJournal(plans);
  const staged: StagedManagedModelFile[] = [];
  journalPaths.set(staged, journalPath);
  try {
    if (process.env.NODE_ENV === "test" && __localModelFilesTestHooks.afterPreparedJournal) {
      await __localModelFilesTestHooks.afterPreparedJournal(journalPath);
    }
    for (const plan of plans) {
      const stage = stageWithJournal(plan, journalPath);
      if (await guardedRenameManagedFile(stage.originalPath, stage.stagedPath, true)) {
        staged.push(stage);
        if (process.env.NODE_ENV === "test" && __localModelFilesTestHooks.afterStage) {
          await __localModelFilesTestHooks.afterStage(stage);
        }
      }
    }
    return staged;
  } catch (error) {
    if (process.env.NODE_ENV === "test" && error instanceof SimulatedManagedModelCrashError) {
      throw error;
    }
    try {
      await rollbackManagedModelFiles(plans.map((stage) => stageWithJournal(stage, journalPath)));
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
    if (await pathExists(stage.stagedPath)) {
      await guardedRenameManagedFile(stage.stagedPath, stage.originalPath, false);
    }
  }
  const journalPath = journalPathFor(stagedFiles);
  if (journalPath) {
    await nativeProfileUnlink("models", profileRelativePath("models", `${journalPath}.committed`), {
      missingOk: true,
    });
    await nativeProfileUnlink("models", profileRelativePath("models", journalPath), {
      missingOk: true,
    });
  }
}

export async function commitManagedModelFiles(
  stagedFiles: readonly StagedManagedModelFile[],
): Promise<number> {
  let removed = 0;
  const pendingPaths: string[] = [];
  for (const stage of stagedFiles) {
    try {
      if (!(await pathExists(stage.stagedPath))) continue;
      if (process.env.NODE_ENV === "test" && __localModelFilesTestHooks.beforeMutation) {
        await __localModelFilesTestHooks.beforeMutation(stage.stagedPath);
      }
      await nativeProfileUnlink("models", profileRelativePath("models", stage.stagedPath), {
        missingOk: true,
      });
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

function validateDeletionRecovery(value: unknown): ManagedModelDeletionRecovery {
  if (!value || typeof value !== "object") {
    throw new Error("Corrupt managed model deletion recovery journal.");
  }
  const recovery = value as Partial<ManagedModelDeletionRecovery>;
  const defaults = recovery.defaults;
  if (
    typeof recovery.ownerId !== "string"
    || recovery.ownerId.length === 0
    || typeof recovery.modelId !== "string"
    || recovery.modelId.length === 0
    || !defaults
    || !Array.isArray(defaults.cleared)
    || !defaults.cleared.every((entry) => entry === "text" || entry === "image")
    || typeof defaults.previous?.defaultTextModel !== "string"
    || typeof defaults.previous?.defaultImageModel !== "string"
    || (recovery.importedModel !== undefined && !isImportedModelRecord(recovery.importedModel))
  ) {
    throw new Error("Corrupt managed model deletion recovery journal.");
  }
  if (recovery.importedModel && recovery.importedModel.id !== recovery.modelId) {
    throw new Error("Managed model deletion recovery journal has mismatched metadata.");
  }
  return {
    ownerId: recovery.ownerId,
    modelId: recovery.modelId,
    ...(recovery.importedModel ? { importedModel: recovery.importedModel } : {}),
    defaults: {
      cleared: [...new Set(defaults.cleared)],
      previous: {
        defaultTextModel: defaults.previous.defaultTextModel,
        defaultImageModel: defaults.previous.defaultImageModel,
      },
    },
  };
}

async function writeManagedCleanupJournal(
  stagedFiles: readonly StagedManagedModelFile[],
  options: { journalPath?: string; recovery?: ManagedModelDeletionRecovery } = {},
): Promise<string> {
  const directory = managedCleanupJournalDir();
  await nativeProfileMkdir("models", profileRelativePath("models", directory));
  const journalPath = options.journalPath ?? path.join(directory, `${randomUUID()}.json`);
  const payload: ManagedModelCleanupJournal = {
    version: 2,
    stages: validateCleanupStages([...stagedFiles]),
    ...(options.recovery ? { recovery: validateDeletionRecovery(options.recovery) } : {}),
  };
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (!options.journalPath) {
    await nativeProfileWrite(
      "models",
      profileRelativePath("models", journalPath),
      bytes,
      { replace: false },
    );
    return journalPath;
  }

  // Never truncate a live prepared journal. Publish the enriched recovery
  // record under a same-directory temporary name, fsync it through the native
  // service, then atomically replace+fsync the old journal. A kill before the
  // rename leaves the old prepared plan intact for byte rollback.
  const tempPath = `${journalPath}.${randomUUID()}.replace-tmp`;
  let preserveTempForCrashTest = false;
  try {
    await nativeProfileWrite(
      "models",
      profileRelativePath("models", tempPath),
      bytes,
      { replace: false },
    );
    if (
      process.env.NODE_ENV === "test"
      && __localModelFilesTestHooks.beforeRecoveryJournalReplace
    ) {
      try {
        await __localModelFilesTestHooks.beforeRecoveryJournalReplace(tempPath);
      } catch (error) {
        preserveTempForCrashTest = error instanceof SimulatedManagedModelCrashError;
        throw error;
      }
    }
    await nativeProfileRename(
      "models",
      profileRelativePath("models", tempPath),
      profileRelativePath("models", journalPath),
      { replace: true },
    );
  } finally {
    if (!preserveTempForCrashTest) {
      await nativeProfileUnlink("models", profileRelativePath("models", tempPath), {
        missingOk: true,
      }).catch(() => undefined);
    }
  }
  return journalPath;
}

async function readManagedCleanupJournal(journalPath: string): Promise<ManagedModelCleanupJournal> {
  const parsed = JSON.parse(await fs.readFile(journalPath, "utf8")) as {
    version?: unknown;
    stages?: unknown;
    recovery?: unknown;
  };
  if (parsed.version !== 2) throw new Error("Corrupt managed model cleanup journal.");
  return {
    version: 2,
    stages: validateCleanupStages(parsed.stages),
    ...(parsed.recovery !== undefined
      ? { recovery: validateDeletionRecovery(parsed.recovery) }
      : {}),
  };
}

/**
 * Durably attach the metadata/default rollback snapshot before either is
 * changed. A crash before this publication only needs to restore staged bytes;
 * a crash afterwards can restore every logical owner before making bytes
 * visible again.
 */
export async function attachManagedModelDeletionRecovery(
  stagedFiles: readonly StagedManagedModelFile[],
  recovery: ManagedModelDeletionRecovery,
): Promise<void> {
  const existingJournalPath = journalPathFor(stagedFiles);
  const journalPath = await writeManagedCleanupJournal(stagedFiles, {
    ...(existingJournalPath ? { journalPath: existingJournalPath } : {}),
    recovery,
  });
  journalPaths.set(stagedFiles as object, journalPath);
  if (process.env.NODE_ENV === "test" && __localModelFilesTestHooks.afterRecoveryJournal) {
    await __localModelFilesTestHooks.afterRecoveryJournal(journalPath);
  }
}

/**
 * Metadata/registry success is the logical delete commit point. Publish a
 * durable cleanup plan before unlinking staged bytes so a cleanup error can be
 * reported as successful-with-pending-work and retried on startup.
 */
export async function markManagedModelFilesCommitted(
  stagedFiles: readonly StagedManagedModelFile[],
): Promise<void> {
  const journalPath = journalPathFor(stagedFiles);
  if (stagedFiles.length === 0 && !journalPath) return;
  if (!journalPath) throw new Error("Managed model deletion has no prepared journal.");
  await nativeProfileWrite(
    "models",
    profileRelativePath("models", `${journalPath}.committed`),
    Buffer.from("committed\n", "utf8"),
    { replace: false },
  );
  if (process.env.NODE_ENV === "test" && __localModelFilesTestHooks.afterCommittedMarker) {
    await __localModelFilesTestHooks.afterCommittedMarker(journalPath);
  }
}

export async function finalizeManagedModelFiles(
  stagedFiles: readonly StagedManagedModelFile[],
): Promise<number> {
  const journalPath = journalPathFor(stagedFiles);
  if (stagedFiles.length === 0 && !journalPath) return 0;
  if (!journalPath || !(await pathExists(`${journalPath}.committed`))) {
    throw new Error("Managed model deletion has no durable committed marker.");
  }
  try {
    const removed = await commitManagedModelFiles(stagedFiles);
    await nativeProfileUnlink("models", profileRelativePath("models", `${journalPath}.committed`), {
      missingOk: true,
    });
    await nativeProfileUnlink("models", profileRelativePath("models", journalPath), {
      missingOk: true,
    });
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
  const orphanTemps = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".replace-tmp"))
    .map((entry) => path.join(directory, entry.name));
  await Promise.all(orphanTemps.map((tempPath) =>
    nativeProfileUnlink("models", profileRelativePath("models", tempPath), {
      missingOk: true,
    })));
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name));
}

async function restoreManagedModelDeletionMetadata(
  recovery: ManagedModelDeletionRecovery,
): Promise<void> {
  if (recovery.importedModel) {
    await upsertImportedModel(recovery.importedModel);
  }
  const data: { defaultTextModel?: string; defaultImageModel?: string } = {};
  if (recovery.defaults.cleared.includes("text")) {
    data.defaultTextModel = recovery.defaults.previous.defaultTextModel;
  }
  if (recovery.defaults.cleared.includes("image")) {
    data.defaultImageModel = recovery.defaults.previous.defaultImageModel;
  }
  if (Object.keys(data).length > 0) {
    await prisma.userSettings.update({
      where: { userId: recovery.ownerId },
      data,
    });
  }
}

/** Roll prepared work back; finish committed cleanup after a process crash. */
export async function reconcileStagedManagedModelFiles(): Promise<number> {
  return withSharedMutationLease(async () => {
    let removed = 0;
    for (const journalPath of await listManagedCleanupJournals()) {
      const journal = await readManagedCleanupJournal(journalPath);
      const stages = journal.stages
        .map((stage) => stageWithJournal(stage, journalPath));
      journalPaths.set(stages, journalPath);
      if (await pathExists(`${journalPath}.committed`)) {
        removed += await commitManagedModelFiles(stages);
        await nativeProfileUnlink("models", profileRelativePath("models", `${journalPath}.committed`), {
          missingOk: true,
        });
        await nativeProfileUnlink("models", profileRelativePath("models", journalPath), {
          missingOk: true,
        });
      } else {
        // Restore logical owners first. If this fails, leave bytes staged and
        // retain the journal so the next cold-start barrier retries without
        // exposing a record/default that points at missing bytes.
        if (journal.recovery) {
          await restoreManagedModelDeletionMetadata(journal.recovery);
        }
        await rollbackManagedModelFiles(stages);
      }
    }
    return removed;
  });
}

/** Compatibility helper for callers that do not have metadata to coordinate. */
export async function removeManagedModelFiles(filePaths: readonly string[]): Promise<number> {
  const staged = await stageManagedModelFiles(filePaths);
  await markManagedModelFilesCommitted(staged);
  return finalizeManagedModelFiles(staged);
}
