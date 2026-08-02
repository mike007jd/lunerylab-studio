import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { ModelCapability, ModelFormat, ModelRuntimeTarget } from "@/lib/hf-model-catalog";
import { ApiError } from "@/lib/server/errors";
import { luneryModelsDir } from "@/lib/server/lunery-profile";
import { withSharedMutationLease } from "@/lib/server/workspace-operation-gate";
import { nativeUnlinkExternalIdentity } from "@/lib/server/native-profile-fs";

export type ImportedModelSource = "local-path" | "huggingface-url";
export type ImportedModelStatus = "ready" | "queued";

export interface ImportedModelRecord {
  id: string;
  label: string;
  source: ImportedModelSource;
  runtimeTarget: ModelRuntimeTarget;
  capability: ModelCapability;
  format: ModelFormat;
  fileName: string;
  modelPath: string;
  sizeBytes: number;
  fileIdentity?: {
    device: string;
    inode: string;
    sizeBytes: string;
    modifiedAtNs: string;
  };
  sha256: string | null;
  status: ImportedModelStatus;
  createdAt: string;
  url?: string;
  jobId?: string;
}

export interface StagedExternalModelFile {
  originalPath: string;
  stagedPath: string;
  journalPath: string;
  hadFile: boolean;
  preservedChangedFile: boolean;
  expectedIdentity: ExternalPathIdentity | null;
}

interface ExternalModelDeleteJournal {
  version: 1;
  modelId: string;
  originalPath: string;
  stagedPath: string;
  recoveryPath?: string;
  preserveFile?: boolean;
  fileIdentity: ExternalPathIdentity;
  record: ImportedModelRecord;
}

type ExternalPathIdentity = NonNullable<ImportedModelRecord["fileIdentity"]> & {
  kind?: "file" | "symlink" | "other";
};

const IMPORTABLE_EXTENSIONS = new Set([".gguf", ".safetensors", ".bin"]);

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

export function modelsCacheRoot(): string {
  return luneryModelsDir();
}

export function modelCacheCandidatePaths(runtimeTarget: ModelRuntimeTarget, fileName: string): string[] {
  return [path.join(modelsCacheRoot(), runtimeTarget, fileName)];
}

/** Canonical on-disk path for a model file: `<modelsRoot>/<runtimeTarget>/<fileName>`. */
export function modelCachePath(runtimeTarget: ModelRuntimeTarget, fileName: string): string {
  return modelCacheCandidatePaths(runtimeTarget, fileName)[0]!;
}

export function importedModelsRegistryPath(): string {
  return path.join(modelsCacheRoot(), "imported-models.json");
}

function externalModelDeleteJournalDir(): string {
  return path.join(modelsCacheRoot(), ".external-delete-journal");
}

function externalModelDeleteJournalPath(modelId: string): string {
  const digest = createHash("sha256").update(modelId).digest("hex").slice(0, 24);
  return path.join(externalModelDeleteJournalDir(), `${digest}.json`);
}

function externalDeleteStagePath(record: ImportedModelRecord): string {
  const digest = createHash("sha256").update(record.id).digest("hex").slice(0, 16);
  return path.join(
    path.dirname(record.modelPath),
    `.${path.basename(record.modelPath)}.lunery-delete-${digest}-${randomUUID()}`,
  );
}

function externalIdentityMatches(
  identity: ExternalPathIdentity,
  stat: import("node:fs").BigIntStats,
): boolean {
  const kindMatches = identity.kind === "symlink"
    ? stat.isSymbolicLink()
    : identity.kind === "other"
      ? !stat.isFile() && !stat.isSymbolicLink()
      : stat.isFile();
  return kindMatches
    && stat.dev.toString() === identity.device
    && stat.ino.toString() === identity.inode
    && stat.size.toString() === identity.sizeBytes
    && stat.mtimeNs.toString() === identity.modifiedAtNs;
}

function externalPathIdentity(stat: import("node:fs").BigIntStats): ExternalPathIdentity {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    sizeBytes: stat.size.toString(),
    modifiedAtNs: stat.mtimeNs.toString(),
    kind: stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other",
  };
}

async function statMatches(
  filePath: string,
  identity: ExternalPathIdentity,
): Promise<boolean> {
  try {
    return externalIdentityMatches(identity, await fs.lstat(filePath, { bigint: true }));
  } catch {
    return false;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: import("node:fs/promises").FileHandle | null = null;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch {
    // Some filesystems do not expose directory fsync. The journal file itself
    // is still synced before publication, and startup reconciliation remains safe.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeExternalDeleteJournal(
  journalPath: string,
  journal: ExternalModelDeleteJournal,
  exclusive = false,
): Promise<void> {
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  const tmpPath = `${journalPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmpPath, "wx");
  try {
    await handle.writeFile(JSON.stringify(journal), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (exclusive) {
      await fs.link(tmpPath, journalPath);
    } else {
      await fs.rename(tmpPath, journalPath);
    }
    await syncDirectory(path.dirname(journalPath));
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}

async function moveFileNoReplace(source: string, destination: string): Promise<void> {
  try {
    await fs.link(source, destination);
    await fs.unlink(source);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw error;
    if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP") throw error;
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    await fs.unlink(source);
  }
}

async function movePathNoReplace(
  source: string,
  destination: string,
  identity: ExternalPathIdentity,
): Promise<void> {
  if (identity.kind !== "other") {
    await moveFileNoReplace(source, destination);
    return;
  }
  const stat = await fs.lstat(source);
  if (!stat.isDirectory()) {
    throw new Error("Unsupported replacement path type.");
  }
  if (await pathExists(destination)) {
    const error = new Error("Destination already exists.") as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  }
  await fs.cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  await fs.rm(source, { recursive: true });
}

function recoveredExternalModelPath(originalPath: string, modelId: string, attempt = 0): string {
  const extension = path.extname(originalPath);
  const stem = path.basename(originalPath, extension);
  const digest = createHash("sha256").update(modelId).digest("hex").slice(0, 8);
  const suffix = attempt === 0 ? "" : `-${attempt}`;
  return path.join(
    path.dirname(originalPath),
    `${stem}.lunery-recovered-${digest}${suffix}${extension}`,
  );
}

async function availableRecoveryPath(originalPath: string, modelId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = recoveredExternalModelPath(originalPath, modelId, attempt);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error("Could not allocate a recovery path for the imported model file.");
}

async function restoreUnexpectedStagedPath(
  record: ImportedModelRecord,
  stagedPath: string,
  journalPath: string,
  identity: ExternalPathIdentity,
): Promise<string> {
  for (let attempt = -1; attempt < 100; attempt += 1) {
    const restoredPath = attempt < 0
      ? record.modelPath
      : recoveredExternalModelPath(record.modelPath, record.id, attempt);
    const journal: ExternalModelDeleteJournal = {
      version: 1,
      modelId: record.id,
      originalPath: record.modelPath,
      stagedPath,
      recoveryPath: restoredPath === record.modelPath ? undefined : restoredPath,
      preserveFile: true,
      fileIdentity: identity,
      record,
    };
    await writeExternalDeleteJournal(journalPath, journal);
    try {
      await movePathNoReplace(stagedPath, restoredPath, identity);
      await fs.unlink(journalPath).catch(() => undefined);
      return restoredPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ERR_FS_CP_EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Could not restore a concurrently replaced imported model path.");
}

export function importedModelDownloadDest(runtimeTarget: ModelRuntimeTarget, modelId: string, fileName: string): string {
  return path.join(modelsCacheRoot(), runtimeTarget, "imported", modelId, fileName);
}

export function normalizeImportableRuntimeTarget(value: string | null | undefined): ModelRuntimeTarget | null {
  const allowed = new Set<ModelRuntimeTarget>(["llama-cpp", "sd-cpp", "ollama", "lm-studio", "comfyui"]);
  return value && allowed.has(value as ModelRuntimeTarget) ? (value as ModelRuntimeTarget) : null;
}

export function safeImportableFileName(value: string): string | null {
  const name = path.basename(value.trim());
  const ext = path.extname(name).toLowerCase();
  if (!name || name === "." || name === "..") return null;
  if (!IMPORTABLE_EXTENSIONS.has(ext)) return null;
  return name;
}

export function inferImportedModelFormat(fileName: string): ModelFormat {
  return path.extname(fileName).toLowerCase() === ".gguf" ? "gguf" : "diffusers";
}

export function inferImportedModelCapability(runtimeTarget: ModelRuntimeTarget, fileName: string): ModelCapability {
  if (runtimeTarget === "sd-cpp" || runtimeTarget === "comfyui") return "image-gen";
  if (runtimeTarget === "ollama" && fileName.toLowerCase().includes("vision")) return "vision";
  return "planner-llm";
}

export function validateImportedRuntimeFormat(
  runtimeTarget: ModelRuntimeTarget,
  fileName: string,
): { capability: ModelCapability; format: ModelFormat } | { error: string } {
  const ext = path.extname(fileName).toLowerCase();
  if (runtimeTarget === "llama-cpp" || runtimeTarget === "ollama" || runtimeTarget === "lm-studio") {
    if (ext !== ".gguf") {
      return { error: `${runtimeTarget} imports require a GGUF model file.` };
    }
    return { capability: inferImportedModelCapability(runtimeTarget, fileName), format: "gguf" };
  }
  if (runtimeTarget === "sd-cpp") {
    if (ext !== ".gguf" && ext !== ".safetensors") {
      return { error: "stable-diffusion.cpp imports require a GGUF or safetensors model file." };
    }
    return { capability: "image-gen", format: inferImportedModelFormat(fileName) };
  }
  if (runtimeTarget === "comfyui") {
    if (ext !== ".safetensors") {
      return { error: "ComfyUI imports require a safetensors model file." };
    }
    return { capability: "image-gen", format: "diffusers" };
  }
  return { error: "Unsupported runtime target." };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

export async function stageImportedExternalModelFile(
  record: ImportedModelRecord,
): Promise<StagedExternalModelFile> {
  const emptyStage = (preservedChangedFile: boolean): StagedExternalModelFile => ({
    originalPath: record.modelPath,
    stagedPath: "",
    journalPath: "",
    hadFile: false,
    preservedChangedFile,
    expectedIdentity: null,
  });
  if (record.source !== "local-path" || !record.fileIdentity) {
    return emptyStage(true);
  }

  let opened: import("node:fs/promises").FileHandle;
  try {
    opened = await fs.open(record.modelPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStage(false);
    throw new ApiError({
      status: 503,
      code: "external_model_file_delete_failed",
      message: "Could not inspect the imported model file. Please try again.",
      retryable: true,
    });
  }
  try {
    const [openedStat, current] = await Promise.all([
      opened.stat({ bigint: true }),
      fs.lstat(record.modelPath, { bigint: true }),
    ]);
    if (
      !externalIdentityMatches(record.fileIdentity, openedStat)
      || !externalIdentityMatches(record.fileIdentity, current)
    ) {
      return emptyStage(true);
    }
  } finally {
    await opened.close();
  }

  const stagedPath = externalDeleteStagePath(record);
  const journalPath = externalModelDeleteJournalPath(record.id);
  const journal: ExternalModelDeleteJournal = {
    version: 1,
    modelId: record.id,
    originalPath: record.modelPath,
    stagedPath,
    fileIdentity: record.fileIdentity,
    record,
  };
  try {
    await writeExternalDeleteJournal(journalPath, journal, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ApiError({
        status: 409,
        code: "external_model_delete_in_progress",
        message: "This imported model already has a pending delete operation. Restart Studio and try again.",
        retryable: true,
      });
    }
    throw new ApiError({
      status: 503,
      code: "external_model_file_delete_failed",
      message: "Could not stage the imported model file for deletion. Please try again.",
      retryable: true,
    });
  }

  try {
    await fs.rename(record.modelPath, stagedPath);
  } catch (error) {
    await fs.unlink(journalPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStage(false);
    throw new ApiError({
      status: 503,
      code: "external_model_file_delete_failed",
      message: "Could not stage the imported model file for deletion. Please try again.",
      retryable: true,
    });
  }

  let stagedIdentity: ExternalPathIdentity;
  try {
    const stagedStat = await fs.lstat(stagedPath, { bigint: true });
    stagedIdentity = externalPathIdentity(stagedStat);
    if (externalIdentityMatches(record.fileIdentity, stagedStat)) {
      return {
        originalPath: record.modelPath,
        stagedPath,
        journalPath,
        hadFile: true,
        preservedChangedFile: false,
        expectedIdentity: record.fileIdentity,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.unlink(journalPath).catch(() => undefined);
      return emptyStage(false);
    }
    throw new ApiError({
      status: 503,
      code: "external_model_delete_rollback_failed",
      message: "The imported model file was preserved in recovery staging. Restart Studio to recover it.",
      retryable: true,
    });
  }

  try {
    await restoreUnexpectedStagedPath(record, stagedPath, journalPath, stagedIdentity);
    return emptyStage(true);
  } catch {
    throw new ApiError({
      status: 503,
      code: "external_model_delete_rollback_failed",
      message: "The imported model file was preserved in recovery staging. Restart Studio to recover it.",
      retryable: true,
    });
  }
}

export async function rollbackImportedExternalModelFile(
  stage: StagedExternalModelFile,
  record: ImportedModelRecord,
): Promise<ImportedModelRecord> {
  if (!stage.hadFile || !record.fileIdentity) return record;
  let restoredPath = stage.originalPath;
  if (await pathExists(stage.originalPath)) {
    restoredPath = await availableRecoveryPath(stage.originalPath, record.id);
    const journal: ExternalModelDeleteJournal = {
      version: 1,
      modelId: record.id,
      originalPath: stage.originalPath,
      stagedPath: stage.stagedPath,
      recoveryPath: restoredPath,
      fileIdentity: record.fileIdentity,
      record,
    };
    await writeExternalDeleteJournal(stage.journalPath, journal);
  }
  await moveFileNoReplace(stage.stagedPath, restoredPath);
  return {
    ...record,
    modelPath: restoredPath,
    fileName: path.basename(restoredPath),
  };
}

export async function finishImportedExternalModelRollback(
  stage: StagedExternalModelFile,
): Promise<void> {
  if (stage.journalPath) await fs.unlink(stage.journalPath).catch(() => undefined);
}

export async function commitImportedExternalModelFile(
  stage: StagedExternalModelFile,
): Promise<number> {
  if (!stage.hadFile) return 0;
  if (!stage.expectedIdentity) {
    throw new Error("Staged external model deletion is missing its expected identity.");
  }
  if (process.env.NODE_ENV === "test" && __importedModelRegistryTestHooks.beforeExternalFinalize) {
    await __importedModelRegistryTestHooks.beforeExternalFinalize(stage);
  }
  // Keep the journal until the native descriptor-relative unlink has matched
  // the exact file staged earlier. A replacement at the staging name is user
  // data: preserve it and leave the journal actionable for startup recovery.
  await nativeUnlinkExternalIdentity(stage.stagedPath, stage.expectedIdentity);
  await fs.unlink(stage.journalPath).catch(() => undefined);
  return 1;
}

export function importedModelId(runtimeTarget: ModelRuntimeTarget, fileName: string, sourceKey = fileName): string {
  const stem = path.basename(fileName, path.extname(fileName));
  const digest = createHash("sha1").update(sourceKey).digest("hex").slice(0, 8);
  return `imported-${runtimeTarget}-${slugify(stem) || "model"}-${digest}`;
}

function isExternalDeleteJournal(value: unknown): value is ExternalModelDeleteJournal {
  if (!value || typeof value !== "object") return false;
  const journal = value as Partial<ExternalModelDeleteJournal>;
  return journal.version === 1
    && typeof journal.modelId === "string"
    && typeof journal.originalPath === "string"
    && path.isAbsolute(journal.originalPath)
    && typeof journal.stagedPath === "string"
    && path.isAbsolute(journal.stagedPath)
    && path.dirname(journal.originalPath) === path.dirname(journal.stagedPath)
    && path.basename(journal.stagedPath).includes(".lunery-delete-")
    && (journal.recoveryPath === undefined || (
      typeof journal.recoveryPath === "string"
      && path.isAbsolute(journal.recoveryPath)
      && path.dirname(journal.recoveryPath) === path.dirname(journal.originalPath)
      && path.basename(journal.recoveryPath).includes(".lunery-recovered-")
    ))
    && (journal.preserveFile === undefined || typeof journal.preserveFile === "boolean")
    && typeof journal.fileIdentity === "object"
    && journal.fileIdentity !== null
    && typeof journal.fileIdentity.device === "string"
    && typeof journal.fileIdentity.inode === "string"
    && typeof journal.fileIdentity.sizeBytes === "string"
    && typeof journal.fileIdentity.modifiedAtNs === "string"
    && (
      journal.fileIdentity.kind === undefined
      || journal.fileIdentity.kind === "file"
      || journal.fileIdentity.kind === "symlink"
      || journal.fileIdentity.kind === "other"
    )
    && isImportedModelRecord(journal.record)
    && journal.record.id === journal.modelId
    && journal.record.source === "local-path"
    && journal.record.modelPath === journal.originalPath;
}

export async function reconcileExternalModelDeleteJournals(): Promise<void> {
  let journalNames: string[];
  try {
    journalNames = (await fs.readdir(externalModelDeleteJournalDir()))
      .filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (journalNames.length === 0) return;

  return withImportedModelRegistryMutation(async () => {
  const records = (await readImportedModelsFrom(importedModelsRegistryPath())) ?? [];
  let registryChanged = false;
  const completed: string[] = [];
  for (const name of journalNames) {
    const journalPath = path.join(externalModelDeleteJournalDir(), name);
    let journal: ExternalModelDeleteJournal;
    try {
      const parsed = JSON.parse(await fs.readFile(journalPath, "utf8")) as unknown;
      if (!isExternalDeleteJournal(parsed)) continue;
      journal = parsed;
    } catch {
      continue;
    }

    const index = records.findIndex((record) => record.id === journal.modelId);
    let stagedIdentity: ExternalPathIdentity | null = null;
    try {
      const stagedStat = await fs.lstat(journal.stagedPath, { bigint: true });
      if (!externalIdentityMatches(journal.fileIdentity, stagedStat)) {
        stagedIdentity = externalPathIdentity(stagedStat);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
    if (stagedIdentity) {
      try {
        const restoredPath = await restoreUnexpectedStagedPath(
          journal.record,
          journal.stagedPath,
          journalPath,
          stagedIdentity,
        );
        if (index >= 0) {
          records[index] = {
            ...records[index]!,
            modelPath: restoredPath,
            fileName: path.basename(restoredPath),
          };
          registryChanged = true;
        }
      } catch {
        // The rewritten journal now owns the actual staged identity. Leave it
        // for the next startup rather than losing the only recovery pointer.
      }
      continue;
    }
    if (journal.preserveFile) {
      let restoredPath: string | null = null;
      if (await statMatches(journal.stagedPath, journal.fileIdentity)) {
        try {
          restoredPath = await restoreUnexpectedStagedPath(
            journal.record,
            journal.stagedPath,
            journalPath,
            journal.fileIdentity,
          );
        } catch {
          continue;
        }
      } else if (await statMatches(journal.originalPath, journal.fileIdentity)) {
        restoredPath = journal.originalPath;
      } else if (
        journal.recoveryPath
        && await statMatches(journal.recoveryPath, journal.fileIdentity)
      ) {
        restoredPath = journal.recoveryPath;
      }
      if (!restoredPath) continue;
      if (index >= 0) {
        records[index] = {
          ...records[index]!,
          modelPath: restoredPath,
          fileName: path.basename(restoredPath),
        };
        registryChanged = true;
      }
      completed.push(journalPath);
      continue;
    }
    if (index < 0 && journal.recoveryPath) {
      let recoveredPath = journal.recoveryPath;
      if (!(await statMatches(recoveredPath, journal.fileIdentity))) {
        if (!(await statMatches(journal.stagedPath, journal.fileIdentity))) continue;
        if (await pathExists(recoveredPath)) {
          recoveredPath = await availableRecoveryPath(journal.originalPath, journal.modelId);
          journal = { ...journal, recoveryPath: recoveredPath };
          await writeExternalDeleteJournal(journalPath, journal);
        }
        await movePathNoReplace(journal.stagedPath, recoveredPath, journal.fileIdentity);
      }
      records.push({
        ...journal.record,
        modelPath: recoveredPath,
        fileName: path.basename(recoveredPath),
      });
      records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      registryChanged = true;
      completed.push(journalPath);
      continue;
    }
    if (index < 0) {
      if (await statMatches(journal.stagedPath, journal.fileIdentity)) {
        await fs.unlink(journal.stagedPath);
      }
      completed.push(journalPath);
      continue;
    }

    let restoredPath: string | null = null;
    if (await statMatches(journal.originalPath, journal.fileIdentity)) {
      restoredPath = journal.originalPath;
      if (await statMatches(journal.stagedPath, journal.fileIdentity)) {
        await fs.unlink(journal.stagedPath);
      }
    } else if (await statMatches(journal.stagedPath, journal.fileIdentity)) {
      restoredPath = journal.originalPath;
      if (await pathExists(journal.originalPath)) {
        restoredPath = journal.recoveryPath
          ?? await availableRecoveryPath(journal.originalPath, journal.modelId);
        if (journal.recoveryPath !== restoredPath) {
          journal = { ...journal, recoveryPath: restoredPath };
          await writeExternalDeleteJournal(journalPath, journal);
        }
      }
      await movePathNoReplace(journal.stagedPath, restoredPath, journal.fileIdentity);
    } else if (
      journal.recoveryPath
      && await statMatches(journal.recoveryPath, journal.fileIdentity)
    ) {
      restoredPath = journal.recoveryPath;
    }
    if (!restoredPath) continue;

    records[index] = {
      ...records[index]!,
      modelPath: restoredPath,
      fileName: path.basename(restoredPath),
    };
    registryChanged = true;
    completed.push(journalPath);
  }

  if (registryChanged) await writeImportedModels(records);
  await Promise.all(completed.map((journalPath) => fs.unlink(journalPath).catch(() => undefined)));
  });
}

const REGISTRY_LOCK = "__luneryImportedModelRegistryLockV1" as const;
const registryGlobal = globalThis as typeof globalThis & {
  [REGISTRY_LOCK]?: Promise<void>;
};

async function withImportedModelRegistryLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = registryGlobal[REGISTRY_LOCK] ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  registryGlobal[REGISTRY_LOCK] = previous.then(() => current, () => current);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
  }
}

async function withImportedModelRegistryMutation<T>(work: () => Promise<T>): Promise<T> {
  return withSharedMutationLease(() => withImportedModelRegistryLock(work));
}

function importedModelRegistryCorrupt(): ApiError {
  return new ApiError({
    status: 500,
    code: "imported_model_registry_corrupt",
    message: "The imported model registry is corrupted and cannot be read.",
    retryable: false,
  });
}

export async function readImportedModels(): Promise<ImportedModelRecord[]> {
  const current = await readImportedModelsFrom(importedModelsRegistryPath());
  if (current) return current;
  return [];
}

async function readImportedModelsFrom(registryPath: string): Promise<ImportedModelRecord[] | null> {
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw importedModelRegistryCorrupt();
    }
    if (!Array.isArray(parsed) || !parsed.every(isImportedModelRecord)) {
      throw importedModelRegistryCorrupt();
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function findImportedModel(id: string): Promise<ImportedModelRecord | undefined> {
  const records = await readImportedModels();
  return records.find((record) => record.id === id);
}

export async function upsertImportedModel(record: ImportedModelRecord): Promise<ImportedModelRecord> {
  return withImportedModelRegistryMutation(async () => {
    const records = await readImportedModels();
    const next = records.filter((item) => item.id !== record.id);
    next.push(record);
    next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await writeImportedModels(next);
    return record;
  });
}

export async function removeImportedModel(id: string): Promise<ImportedModelRecord | undefined> {
  return withImportedModelRegistryMutation(async () => {
    const records = await readImportedModels();
    const removed = records.find((record) => record.id === id);
    if (!removed) return undefined;
    await writeImportedModels(records.filter((record) => record.id !== id));
    return removed;
  });
}

export async function removeImportedModelIfUnchanged(
  expected: ImportedModelRecord,
): Promise<ImportedModelRecord> {
  return withImportedModelRegistryMutation(async () => {
    const records = await readImportedModels();
    const current = records.find((record) => record.id === expected.id);
    if (!sameImportedModelRecord(current, expected)) {
      throw new ApiError({
        status: 409,
        code: "model_import_in_progress",
        message: "This model changed while deletion was being prepared. Try again.",
        retryable: true,
      });
    }
    await writeImportedModels(records.filter((record) => record.id !== expected.id));
    return expected;
  });
}

export interface QueuedImportedModelMutation {
  record: ImportedModelRecord;
  previous?: ImportedModelRecord;
}

/**
 * Bridge start may have been accepted even though its HTTP response was lost.
 * This marker tells the registry reservation to retain queued ownership; only
 * a definitive rejection is safe to compensate.
 */
export class QueuedImportedModelStartUncertainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QueuedImportedModelStartUncertainError";
  }
}

function sameImportedModelRecord(
  left: ImportedModelRecord | undefined,
  right: ImportedModelRecord | undefined,
): boolean {
  if (!left || !right) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Keep the registry mutex and workspace shared lease from the queued write
 * through bridge start acknowledgement. This prevents same-id imports or
 * deletes from creating an unowned native download between those phases.
 */
export async function withQueuedImportedModelReservation<T>({
  record,
  expectedPrevious,
  start,
}: {
  record: ImportedModelRecord;
  expectedPrevious?: ImportedModelRecord;
  start: () => Promise<T>;
}): Promise<{ record: ImportedModelRecord; result: T }> {
  if (record.source !== "huggingface-url" || record.status !== "queued" || !record.jobId) {
    throw new Error("Only a queued Hugging Face import can reserve bridge start.");
  }
  return withImportedModelRegistryMutation(async () => {
    const records = await readImportedModels();
    const current = records.find((item) => item.id === record.id);
    if (!sameImportedModelRecord(current, expectedPrevious)) {
      throw new ApiError({
        status: 409,
        code: "model_import_in_progress",
        message: "This model import changed while another download was starting. Try again.",
        retryable: true,
      });
    }

    const queuedRecords = records.filter((item) => item.id !== record.id);
    queuedRecords.push(record);
    queuedRecords.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await writeImportedModels(queuedRecords);

    try {
      return { record, result: await start() };
    } catch (startError) {
      if (startError instanceof QueuedImportedModelStartUncertainError) {
        throw startError;
      }
      const restored = records.filter((item) => item.id !== record.id);
      if (expectedPrevious) restored.push(expectedPrevious);
      restored.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      try {
        await writeImportedModels(restored);
      } catch (compensationError) {
        console.error("[model-import] queued registry compensation failed", {
          compensationError,
          jobId: record.jobId,
          modelId: record.id,
          startError,
        });
        throw new ApiError({
          status: 500,
          code: "imported_model_registry_compensation_failed",
          message: "Bridge start failed and the queued model registry state could not be rolled back.",
          retryable: false,
        });
      }
      throw startError;
    }
  });
}

export async function queueImportedModel(
  record: ImportedModelRecord,
): Promise<QueuedImportedModelMutation> {
  if (record.source !== "huggingface-url" || record.status !== "queued" || !record.jobId) {
    throw new Error("Only a queued Hugging Face import can be registered before bridge start.");
  }
  return withImportedModelRegistryMutation(async () => {
    const records = await readImportedModels();
    const previous = records.find((item) => item.id === record.id);
    const next = records.filter((item) => item.id !== record.id);
    next.push(record);
    next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await writeImportedModels(next);
    return { record, ...(previous ? { previous } : {}) };
  });
}

/**
 * Compensate a bridge launch failure without deleting a prior import or a
 * newer concurrent queue. Returns false when this failed job no longer owns
 * the registry slot, in which case the newer state is intentionally kept.
 */
export async function restoreImportedModelAfterFailedQueue(
  mutation: QueuedImportedModelMutation,
): Promise<boolean> {
  return withImportedModelRegistryMutation(async () => {
    const records = await readImportedModels();
    const current = records.find((item) => item.id === mutation.record.id);
    if (current?.jobId !== mutation.record.jobId || current?.status !== "queued") {
      return false;
    }
    const next = records.filter((item) => item.id !== mutation.record.id);
    if (mutation.previous) next.push(mutation.previous);
    next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await writeImportedModels(next);
    return true;
  });
}

/** Test-only hook to inject write failures after the lock is held. */
export const __importedModelRegistryTestHooks = {
  beforeWrite: null as null | (() => Promise<void> | void),
  beforeExternalFinalize: null as null | ((stage: StagedExternalModelFile) => Promise<void> | void),
};

async function writeImportedModels(records: ImportedModelRecord[]): Promise<void> {
  if (__importedModelRegistryTestHooks.beforeWrite) {
    await __importedModelRegistryTestHooks.beforeWrite();
  }
  const registryPath = importedModelsRegistryPath();
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmpPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(records, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, registryPath);
    await syncDirectory(path.dirname(registryPath));
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}

export async function resolveLocalModelPath(input: string): Promise<{
  modelPath: string;
  fileName: string;
  sizeBytes: number;
  fileIdentity: NonNullable<ImportedModelRecord["fileIdentity"]>;
} | {
  error: string;
}> {
  const trimmed = input.trim();
  if (!trimmed) return { error: "Paste an absolute path to a local model file." };
  const expanded = trimmed.startsWith("~/") ? path.join(homeDir(), trimmed.slice(2)) : trimmed;
  if (!path.isAbsolute(expanded)) return { error: "Use an absolute local model path." };

  const fileName = safeImportableFileName(expanded);
  if (!fileName) return { error: "Use a .gguf, .safetensors, or .bin model file." };

  try {
    const stat = await fs.lstat(expanded, { bigint: true });
    if (!stat.isFile()) return { error: "The model path must point to a file." };
    const sizeBytes = Number(stat.size);
    if (!Number.isSafeInteger(sizeBytes)) return { error: "The model file is too large to index safely." };
    return {
      modelPath: path.resolve(expanded),
      fileName,
      sizeBytes,
      fileIdentity: {
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
        sizeBytes: stat.size.toString(),
        modifiedAtNs: stat.mtimeNs.toString(),
      },
    };
  } catch {
    return { error: "The model file does not exist." };
  }
}

function isImportedModelRecord(value: unknown): value is ImportedModelRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ImportedModelRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.modelPath === "string" &&
    typeof record.fileName === "string" &&
    typeof record.runtimeTarget === "string" &&
    typeof record.capability === "string" &&
    typeof record.format === "string" &&
    typeof record.sizeBytes === "number" &&
    (record.fileIdentity === undefined || (
      typeof record.fileIdentity === "object" &&
      record.fileIdentity !== null &&
      typeof record.fileIdentity.device === "string" &&
      typeof record.fileIdentity.inode === "string" &&
      typeof record.fileIdentity.sizeBytes === "string" &&
      typeof record.fileIdentity.modifiedAtNs === "string"
    ))
  );
}
