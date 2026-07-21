import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/server/prisma";
import {
  listStoredRelativePaths,
  readStoredFile,
} from "@/lib/server/storage";
import { ApiError } from "@/lib/server/errors";
import { luneryConfigDir, luneryMediaDir } from "@/lib/server/lunery-profile";

/**
 * Workspace backup / restore.
 *
 * Backup exports the full local database plus media into one self-describing
 * object with a manifest (app + schema version, per-file checksums, row counts).
 * Restore validates that manifest and refuses a partial or mismatched restore.
 *
 * Deliberately excluded: OS-keychain provider secrets. They live in the system
 * keychain, never in the DB, so a backup can be shared/moved without leaking
 * API keys. `manifest.excluded` records this.
 *
 * Restore replaces the current workspace after explicit confirmation. Incoming
 * media/config are fully staged and directory-swapped before the database
 * transaction; any database failure swaps the old directories back.
 */

export const BACKUP_FORMAT = "lunery-workspace-backup";
export const BACKUP_VERSION = 2;
/** Bump alongside any prisma/migrations change so a stale backup can't restore. */
export const CURRENT_SCHEMA_VERSION = "20260601000000_initial";
const APP_VERSION = "1.0.0";

// Prisma model delegates, listed so a parent is always created before its
// children on restore. Circular / self nullable FKs are stripped on first insert
// and set in a second pass (see STRIP_ON_INSERT).
const RESTORE_ORDER = [
  "appState",
  "user",
  "userSettings",
  "project",
  "generationJob",
  "asset",
  "canvasSession",
  "canvasSnapshot",
  "agentTask",
  "canvasLayer",
  "agentMessage",
  "agentTaskStep",
  "referenceSet",
  "referenceSetAsset",
] as const;

type ModelName = (typeof RESTORE_ORDER)[number];

// Nullable FK columns that point at rows created later (or the same table), so
// they must be nulled on the first insert and back-filled afterward.
const STRIP_ON_INSERT: Partial<Record<ModelName, string[]>> = {
  generationJob: ["agentTaskId"],
  asset: ["agentTaskId", "parentAssetId"],
  canvasSession: ["selectedAssetId"],
  agentTask: ["beforeSnapshotId"],
};

export interface WorkspaceBackup {
  manifest: {
    format: string;
    version: number;
    appVersion: string;
    schemaVersion: string;
    createdAt: string;
    counts: Record<string, number>;
    dataSha256: string;
    media: Array<{ path: string; sha256: string; bytes: number }>;
    config: Array<{ path: string; sha256: string; bytes: number }>;
    excluded: string[];
  };
  data: Record<string, Record<string, unknown>[]>;
  media: Array<{ path: string; base64: string }>;
  config: Array<{ path: string; base64: string }>;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function dataChecksum(data: WorkspaceBackup["data"]): string {
  return sha256(Buffer.from(JSON.stringify(data)));
}

function assertRelativeBackupPath(value: string, allowedRoots?: ReadonlySet<string>): string {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw new Error("Invalid backup path");
  }
  const normalized = path.posix.normalize(value);
  const parts = normalized.split("/");
  if (
    normalized !== value ||
    parts.some((part) => !part || part === "." || part === "..") ||
    (allowedRoots && !allowedRoots.has(parts[0]!))
  ) {
    throw new Error("Invalid backup path");
  }
  return normalized;
}

async function listDirectoryFiles(root: string): Promise<Array<{ path: string; bytes: Buffer }>> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push({ path: relative, bytes: await fs.readFile(absolute) });
      else throw new Error(`Unsupported config entry in backup: ${relative}`);
    }
  }
  await visit(root, "");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function delegate(model: ModelName) {
  // The prisma client exposes each model as a delegate keyed by its camelCase
  // name; the RESTORE_ORDER union keeps this access type-safe at the call sites.
  return (prisma as unknown as Record<ModelName, {
    findMany: (args?: unknown) => Promise<Record<string, unknown>[]>;
    createMany: (args: { data: Record<string, unknown>[] }) => Promise<unknown>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    count: () => Promise<number>;
  }>)[model];
}

/**
 * Build a full workspace backup. Read-only. `createdAt` is injected by the caller
 * so this stays deterministic/testable.
 */
export async function exportWorkspaceBackup(createdAt: string): Promise<WorkspaceBackup> {
  const data: WorkspaceBackup["data"] = {};
  const counts: Record<string, number> = {};
  for (const model of RESTORE_ORDER) {
    const rows = await delegate(model).findMany();
    data[model] = rows;
    counts[model] = rows.length;
  }

  const media: WorkspaceBackup["media"] = [];
  const mediaManifest: WorkspaceBackup["manifest"]["media"] = [];
  for (const path of await listStoredRelativePaths()) {
    const { file } = await readStoredFile(path);
    media.push({ path, base64: file.toString("base64") });
    mediaManifest.push({ path, sha256: sha256(file), bytes: file.byteLength });
  }

  const configFiles = await listDirectoryFiles(luneryConfigDir());
  const config = configFiles.map((entry) => ({ path: entry.path, base64: entry.bytes.toString("base64") }));
  const configManifest = configFiles.map((entry) => ({
    path: entry.path,
    sha256: sha256(entry.bytes),
    bytes: entry.bytes.byteLength,
  }));

  return {
    manifest: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      appVersion: APP_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt,
      counts,
      dataSha256: dataChecksum(data),
      media: mediaManifest,
      config: configManifest,
      excluded: ["keychain-secrets", "models", "logs", "runtime-temp"],
    },
    data,
    media,
    config,
  };
}

function integrityError(code: string, message: string): never {
  throw new ApiError({ status: 400, code, message, retryable: false });
}

function verifyFilePayloads(
  label: "media" | "config",
  manifest: Array<{ path: string; sha256: string; bytes: number }>,
  payloads: Array<{ path: string; base64: string }>,
): void {
  const allowedRoots = label === "media" ? new Set(["generated", "uploads"]) : undefined;
  const byPath = new Map<string, string>();
  for (const payload of payloads) {
    try {
      assertRelativeBackupPath(payload.path, allowedRoots);
    } catch {
      integrityError(`backup_${label}_path_invalid`, `Backup contains an invalid ${label} path.`);
    }
    if (byPath.has(payload.path)) {
      integrityError(`backup_${label}_duplicate`, `Backup contains duplicate ${label} payloads for ${payload.path}.`);
    }
    byPath.set(payload.path, payload.base64);
  }

  const manifestPaths = new Set<string>();
  for (const entry of manifest) {
    if (manifestPaths.has(entry.path)) {
      integrityError(`backup_${label}_duplicate`, `Backup manifest contains duplicate ${label} entries for ${entry.path}.`);
    }
    manifestPaths.add(entry.path);
    const base64 = byPath.get(entry.path);
    if (base64 === undefined) {
      integrityError(`backup_${label}_missing`, `Backup is missing ${label} payload for ${entry.path}.`);
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64 || bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
      integrityError(`backup_${label}_corrupt`, `Checksum mismatch for ${entry.path}; refusing partial restore.`);
    }
  }
  if (byPath.size !== manifestPaths.size) {
    integrityError(`backup_${label}_unexpected`, `Backup contains ${label} payloads that are absent from the manifest.`);
  }
}

/**
 * Validate a backup's manifest and media integrity. Throws on any mismatch so a
 * corrupt/incompatible backup can never be partially restored.
 */
export function verifyBackupIntegrity(backup: WorkspaceBackup): void {
  const m = backup?.manifest;
  if (!m || m.format !== BACKUP_FORMAT || m.version !== BACKUP_VERSION) {
    throw new ApiError({
      status: 400,
      code: "backup_unrecognized",
      message: "Not a recognized Lunery workspace backup.",
      retryable: false,
    });
  }
  if (m.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new ApiError({
      status: 409,
      code: "backup_schema_mismatch",
      message: `Backup schema ${m.schemaVersion} does not match current ${CURRENT_SCHEMA_VERSION}.`,
      retryable: false,
    });
  }
  if (!backup.data || typeof backup.data !== "object" || dataChecksum(backup.data) !== m.dataSha256) {
    integrityError("backup_data_corrupt", "Workspace data checksum mismatch; refusing restore.");
  }
  const dataKeys = Object.keys(backup.data).sort();
  const expectedKeys = [...RESTORE_ORDER].sort();
  if (JSON.stringify(dataKeys) !== JSON.stringify(expectedKeys)) {
    integrityError("backup_data_shape_invalid", "Backup workspace data shape is incomplete or unsupported.");
  }
  for (const model of RESTORE_ORDER) {
    const rows = backup.data[model];
    if (!Array.isArray(rows) || m.counts[model] !== rows.length) {
      integrityError("backup_data_count_mismatch", `Backup row count mismatch for ${model}.`);
    }
  }
  if (!Array.isArray(backup.media) || !Array.isArray(m.media) || !Array.isArray(backup.config) || !Array.isArray(m.config)) {
    integrityError("backup_unrecognized", "Backup file payloads are incomplete.");
  }
  verifyFilePayloads("media", m.media, backup.media);
  verifyFilePayloads("config", m.config, backup.config);
}

// Revive top-level ISO-8601 datetime strings back to Date objects (JSON dropped
// the type on export). Only top-level scalars are touched — Prisma DateTime
// columns are always top-level, so nested JSON payloads are left intact.
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
function reviveDates(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = key.endsWith("At") && typeof value === "string" && ISO_DATETIME.test(value)
      ? new Date(value)
      : value;
  }
  return out;
}

/**
 * Replace the current workspace with a verified backup. Incoming files are
 * staged first; directory swaps are rolled back if the DB transaction fails.
 */
export async function restoreWorkspaceBackup(
  backup: WorkspaceBackup,
  options: { confirm: boolean },
): Promise<{ counts: Record<string, number>; mediaRestored: number; configRestored: number; warnings: string[] }> {
  if (!options.confirm) {
    throw new ApiError({
      status: 400,
      code: "restore_not_confirmed",
      message: "Restore must be explicitly confirmed; it overwrites the workspace.",
      retryable: false,
    });
  }
  verifyBackupIntegrity(backup);

  const counts: Record<string, number> = {};
  const deferredUpdates: Array<{ model: ModelName; id: string; data: Record<string, unknown> }> = [];

  const stageDirectory = async (
    root: string,
    entries: Array<{ path: string; base64: string }>,
    allowedRoots?: ReadonlySet<string>,
  ) => {
    const token = randomUUID();
    const staged = path.join(path.dirname(root), `.${path.basename(root)}.restore-stage-${token}`);
    const previous = path.join(path.dirname(root), `.${path.basename(root)}.restore-previous-${token}`);
    try {
      await fs.mkdir(staged, { recursive: true });
      for (const entry of entries) {
        const relative = assertRelativeBackupPath(entry.path, allowedRoots);
        const target = path.join(staged, ...relative.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, Buffer.from(entry.base64, "base64"), { flag: "wx" });
      }
    } catch (error) {
      await fs.rm(staged, { recursive: true, force: true });
      throw error;
    }
    return { root, staged, previous, previousExists: false, active: false };
  };

  const swaps: Awaited<ReturnType<typeof stageDirectory>>[] = [];
  try {
    swaps.push(await stageDirectory(luneryMediaDir(), backup.media, new Set(["generated", "uploads"])));
    swaps.push(await stageDirectory(luneryConfigDir(), backup.config));
  } catch (error) {
    await Promise.allSettled(swaps.map((swap) => fs.rm(swap.staged, { recursive: true, force: true })));
    throw error;
  }

  const pathExists = async (value: string) => fs.access(value).then(() => true, () => false);
  const rollbackSwaps = async () => {
    const failures: unknown[] = [];
    for (const swap of [...swaps].reverse()) {
      try {
        if (swap.active) await fs.rm(swap.root, { recursive: true, force: true });
        if (swap.previousExists) await fs.rename(swap.previous, swap.root);
        await fs.rm(swap.staged, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new ApiError({
        status: 500,
        code: "restore_rollback_failed",
        message: "Restore failed and the previous local files could not be fully restored.",
        retryable: false,
      });
    }
  };

  try {
    for (const swap of swaps) {
      await fs.mkdir(path.dirname(swap.root), { recursive: true });
      swap.previousExists = await pathExists(swap.root);
      if (swap.previousExists) await fs.rename(swap.root, swap.previous);
      await fs.rename(swap.staged, swap.root);
      swap.active = true;
    }

    await prisma.$transaction(async (tx) => {
    const txDelegate = (model: ModelName) =>
      (tx as unknown as Record<ModelName, {
        createMany: (args: { data: Record<string, unknown>[] }) => Promise<unknown>;
        update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
        updateMany: (args: { data: Record<string, unknown> }) => Promise<unknown>;
        deleteMany: () => Promise<unknown>;
      }>)[model];

    await txDelegate("generationJob").updateMany({ data: { agentTaskId: null } });
    await txDelegate("asset").updateMany({ data: { agentTaskId: null, parentAssetId: null } });
    await txDelegate("canvasSession").updateMany({ data: { selectedAssetId: null } });
    await txDelegate("agentTask").updateMany({ data: { beforeSnapshotId: null } });
    for (const model of [...RESTORE_ORDER].reverse()) await txDelegate(model).deleteMany();

    for (const model of RESTORE_ORDER) {
      const rows = (backup.data[model] ?? []).map(reviveDates);
      if (rows.length === 0) {
        counts[model] = 0;
        continue;
      }
      const strip = STRIP_ON_INSERT[model];
      const insertRows = rows.map((row) => {
        if (!strip) return row;
        const copy = { ...row };
        const carried: Record<string, unknown> = {};
        for (const field of strip) {
          if (copy[field] != null) carried[field] = copy[field];
          copy[field] = null;
        }
        // Prisma refreshes @updatedAt on the deferred FK update. Carry the
        // original timestamp through the second pass so restore is lossless.
        if (Object.keys(carried).length > 0 && copy.updatedAt != null) {
          carried.updatedAt = copy.updatedAt;
        }
        if (Object.keys(carried).length > 0) {
          deferredUpdates.push({ model, id: String(copy.id), data: carried });
        }
        return copy;
      });
      await txDelegate(model).createMany({ data: insertRows });
      counts[model] = insertRows.length;
    }

    // Second pass: set the stripped circular / self FKs now that every row exists.
    for (const update of deferredUpdates) {
      await txDelegate(update.model).update({ where: { id: update.id }, data: update.data });
    }
    });
  } catch (error) {
    await rollbackSwaps();
    throw error;
  }

  const warnings: string[] = [];
  for (const swap of swaps) {
    if (!swap.previousExists) continue;
    try {
      await fs.rm(swap.previous, { recursive: true, force: true });
    } catch {
      warnings.push(`Previous ${path.basename(swap.root)} directory could not be removed.`);
    }
  }

  return {
    counts,
    mediaRestored: backup.media.length,
    configRestored: backup.config.length,
    warnings,
  };
}
