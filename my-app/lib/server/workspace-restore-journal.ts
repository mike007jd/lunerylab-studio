import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/server/prisma";
import { luneryConfigDir, luneryDataDir, luneryMediaDir } from "@/lib/server/lunery-profile";
import {
  nativeCleanupWorkspaceRestore,
  nativeRefreshWorkspaceRestoreRoots,
  nativeRollbackWorkspaceRestoreRoots,
  type NativeWorkspaceRestoreOriginalIdentities,
  type NativeWorkspaceRestoreStagedIdentities,
} from "@/lib/server/native-profile-fs";
import {
  getWorkspaceExclusiveCapability,
  hasWorkspaceMutationAuthority,
  withWorkspaceExclusive,
} from "@/lib/server/workspace-operation-gate";

export const RESTORE_JOURNAL_FORMAT = "lunery-workspace-restore-journal";
export const RESTORE_JOURNAL_VERSION = 1;
export const WORKSPACE_RESTORE_COMMIT_ID = "singleton";

/** Safe restore token: no path separators or traversal; UUID-compatible. */
const RESTORE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export interface RestoreJournalSwap {
  root: string;
  staged: string;
  previous: string;
  previousExisted: boolean;
  originalDevice: string;
  originalInode: string;
  stagedDevice: string | null;
  stagedInode: string | null;
}

export interface RestoreJournal {
  format: typeof RESTORE_JOURNAL_FORMAT;
  version: typeof RESTORE_JOURNAL_VERSION;
  token: string;
  swaps: RestoreJournalSwap[];
}

function recoveryDir(): string {
  return path.join(luneryDataDir(), "recovery");
}

export function restoreJournalPath(): string {
  return path.join(recoveryDir(), "workspace-restore.json");
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/**
 * Flush file contents to durable storage. Node 22 FileHandle.sync is available.
 */
export async function fsyncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Flush directory metadata where the platform supports it. Windows commonly
 * rejects directory fsync with EPERM/EINVAL/EBADF; those are the only codes
 * treated as a documented no-op. Other failures propagate.
 */
export async function fsyncDirectory(dirPath: string): Promise<void> {
  try {
    const handle = await fs.open(dirPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (
      process.platform === "win32" &&
      (code === "EPERM" || code === "EINVAL" || code === "EBADF")
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Recursively fsync every regular file, then directory metadata bottom-up, so
 * journal-owned staged trees are durable before any live-root rename.
 */
export async function fsyncTree(root: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await fsyncTree(absolute);
    } else if (entry.isFile()) {
      await fsyncFile(absolute);
    }
  }
  await fsyncDirectory(root);
}

export async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

export function assertRestoreToken(token: string): string {
  if (!RESTORE_TOKEN_PATTERN.test(token)) {
    throw new Error("Corrupt workspace restore journal token.");
  }
  return token;
}

function siblingRestorePath(root: string, kind: "stage" | "previous", token: string): string {
  return path.join(path.dirname(root), `.${path.basename(root)}.restore-${kind}-${token}`);
}

/**
 * Canonical media+config swap descriptors for the current resolved profile roots
 * and a restore token. Callers fill `previousExisted` after probing the roots.
 */
export function buildExpectedRestoreSwaps(
  token: string,
): Omit<
  RestoreJournalSwap,
  "previousExisted" | "originalDevice" | "originalInode" | "stagedDevice" | "stagedInode"
>[] {
  assertRestoreToken(token);
  const mediaRoot = path.resolve(luneryMediaDir());
  const configRoot = path.resolve(luneryConfigDir());
  return [
    {
      root: mediaRoot,
      staged: siblingRestorePath(mediaRoot, "stage", token),
      previous: siblingRestorePath(mediaRoot, "previous", token),
    },
    {
      root: configRoot,
      staged: siblingRestorePath(configRoot, "stage", token),
      previous: siblingRestorePath(configRoot, "previous", token),
    },
  ];
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

/**
 * Fail closed: journal paths must exactly match current media/config roots and
 * token-derived stage/previous siblings. Hostile or stale absolute paths never
 * authorize mutation.
 */
export function validateRestoreJournal(journal: RestoreJournal): RestoreJournal {
  if (
    !journal ||
    journal.format !== RESTORE_JOURNAL_FORMAT ||
    journal.version !== RESTORE_JOURNAL_VERSION ||
    typeof journal.token !== "string" ||
    !Array.isArray(journal.swaps)
  ) {
    throw new Error("Corrupt workspace restore journal.");
  }
  const token = assertRestoreToken(journal.token);
  const expected = buildExpectedRestoreSwaps(token);
  if (journal.swaps.length !== expected.length) {
    throw new Error("Corrupt workspace restore journal swaps.");
  }
  const swaps: RestoreJournalSwap[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const actual = journal.swaps[index];
    const want = expected[index]!;
    if (
      !actual ||
      typeof actual.root !== "string" ||
      typeof actual.staged !== "string" ||
      typeof actual.previous !== "string" ||
      typeof actual.previousExisted !== "boolean" ||
      typeof actual.originalDevice !== "string" ||
      typeof actual.originalInode !== "string" ||
      !/^\d+$/.test(actual.originalDevice) ||
      !/^\d+$/.test(actual.originalInode) ||
      !(
        (actual.stagedDevice === null && actual.stagedInode === null)
        || (
          typeof actual.stagedDevice === "string"
          && typeof actual.stagedInode === "string"
          && /^\d+$/.test(actual.stagedDevice)
          && /^\d+$/.test(actual.stagedInode)
        )
      ) ||
      !samePath(actual.root, want.root) ||
      !samePath(actual.staged, want.staged) ||
      !samePath(actual.previous, want.previous)
    ) {
      throw new Error("Corrupt or hostile workspace restore journal paths.");
    }
    swaps.push({
      root: want.root,
      staged: want.staged,
      previous: want.previous,
      previousExisted: actual.previousExisted,
      originalDevice: actual.originalDevice,
      originalInode: actual.originalInode,
      stagedDevice: actual.stagedDevice,
      stagedInode: actual.stagedInode,
    });
  }
  const stagedIdentityCount = swaps.filter((swap) => swap.stagedDevice !== null).length;
  if (stagedIdentityCount !== 0 && stagedIdentityCount !== swaps.length) {
    throw new Error("Corrupt workspace restore staged identities.");
  }
  return {
    format: RESTORE_JOURNAL_FORMAT,
    version: RESTORE_JOURNAL_VERSION,
    token,
    swaps,
  };
}

function journalStagedIdentities(journal: RestoreJournal): NativeWorkspaceRestoreStagedIdentities {
  const media = journal.swaps[0]!;
  const config = journal.swaps[1]!;
  if (media.stagedDevice === null || config.stagedDevice === null) return null;
  return {
    media: { device: media.stagedDevice, inode: media.stagedInode! },
    config: { device: config.stagedDevice, inode: config.stagedInode! },
  };
}

function journalOriginalIdentities(
  journal: RestoreJournal,
): NativeWorkspaceRestoreOriginalIdentities {
  const media = journal.swaps[0]!;
  const config = journal.swaps[1]!;
  return {
    media: { device: media.originalDevice, inode: media.originalInode },
    config: { device: config.originalDevice, inode: config.originalInode },
  };
}

/**
 * Atomically persist the restore journal and fsync the file plus containing
 * directory before the first filesystem rename.
 */
export async function writeRestoreJournal(journal: RestoreJournal): Promise<void> {
  const validated = validateRestoreJournal(journal);
  const dir = recoveryDir();
  await fs.mkdir(dir, { recursive: true });
  const target = restoreJournalPath();
  const temp = path.join(dir, `.workspace-restore.${validated.token}.tmp`);
  const payload = `${JSON.stringify(validated)}\n`;
  const handle = await fs.open(temp, "w");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, target);
  await fsyncFile(target);
  await fsyncDirectory(dir);
}

export async function readRestoreJournal(): Promise<RestoreJournal | null> {
  const target = restoreJournalPath();
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as RestoreJournal;
  } catch {
    throw new Error("Corrupt workspace restore journal.");
  }
  return validateRestoreJournal(parsed as RestoreJournal);
}

export async function removeRestoreJournal(): Promise<void> {
  const target = restoreJournalPath();
  try {
    await fs.unlink(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  await fsyncDirectory(recoveryDir()).catch((error) => {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  });
}

async function readCommitToken(): Promise<string | null> {
  try {
    const row = await prisma.workspaceRestoreCommit.findUnique({
      where: { id: WORKSPACE_RESTORE_COMMIT_ID },
      select: { token: true },
    });
    return row?.token ?? null;
  } catch (error) {
    // Fresh profiles may not have the table until migrate; treat as absent only
    // when the relation is missing from an uninitialized client surface.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2021"
    ) {
      return null;
    }
    throw error;
  }
}

export async function writeRestoreCommitMarker(
  token: string,
  client: {
    workspaceRestoreCommit: {
      upsert: (args: {
        where: { id: string };
        create: { id: string; token: string };
        update: { token: string };
      }) => Promise<unknown>;
    };
  } = prisma,
): Promise<void> {
  assertRestoreToken(token);
  await client.workspaceRestoreCommit.upsert({
    where: { id: WORKSPACE_RESTORE_COMMIT_ID },
    create: { id: WORKSPACE_RESTORE_COMMIT_ID, token },
    update: { token },
  });
}

export async function clearRestoreCommitMarker(): Promise<void> {
  await prisma.workspaceRestoreCommit.deleteMany({
    where: { id: WORKSPACE_RESTORE_COMMIT_ID },
  });
}

/**
 * Reconcile a crash mid-restore into a deterministic old+old or new+new state.
 * Journal absent → no-op (clear orphan marker). Marker absent → phase-correct
 * rollback. Marker present for the journal token → keep new roots and finish
 * cleanup. The filesystem journal is removed only after deterministic recovery
 * work completes, and before the DB marker, so a crash cannot leave an
 * ambiguous "marker without journal" gap.
 */
async function reconcileWorkspaceRestoreStateWithAuthority(): Promise<void> {
  let journal: RestoreJournal | null;
  try {
    journal = await readRestoreJournal();
  } catch (error) {
    // Fail closed: corrupt/hostile journals must not authorize deletes.
    throw error;
  }
  if (!journal) {
    await clearRestoreCommitMarker();
    return;
  }

  const commitToken = await readCommitToken();
  if (commitToken === journal.token) {
    // Validate the whole committed pair before deleting any previous tree.
    // Otherwise a missing config root could be discovered only after the
    // recoverable media baseline had already been discarded.
    for (const swap of journal.swaps) {
      if (!(await pathExists(swap.root))) {
        throw new Error(
          `Committed workspace restore root is missing: ${path.basename(swap.root)}`,
        );
      }
    }
    // Startup may have freshly pinned these roots; an in-process recovery may
    // still hold the pre-swap identities. The native boundary validates the
    // live roots before publishing both identities together.
    const stagedIdentities = journalStagedIdentities(journal);
    await nativeRefreshWorkspaceRestoreRoots(journal.token, stagedIdentities);
    await nativeCleanupWorkspaceRestore(
      journal.token,
      journalOriginalIdentities(journal),
      stagedIdentities,
    );
  } else {
    await nativeRollbackWorkspaceRestoreRoots(
      journal.token,
      journalOriginalIdentities(journal),
      journalStagedIdentities(journal),
    );
  }

  await removeRestoreJournal();
  await clearRestoreCommitMarker();
}

export async function reconcileWorkspaceRestoreState(): Promise<void> {
  if (getWorkspaceExclusiveCapability()) {
    return reconcileWorkspaceRestoreStateWithAuthority();
  }
  if (hasWorkspaceMutationAuthority()) {
    throw new Error("Workspace restore reconciliation cannot begin from a shared mutation lease.");
  }
  return withWorkspaceExclusive(
    "destructive-reconcile",
    reconcileWorkspaceRestoreStateWithAuthority,
  );
}

let reconcilePromise: Promise<void> | null = null;

/**
 * Single-flight startup reconciliation before workspace APIs read or mutate
 * profile state. Recovery owns exclusive authority so sync config writers
 * cannot race a media/config swap. An already-exclusive restore may re-enter;
 * a shared caller fails closed instead of waiting on its own lease forever.
 */
export function ensureWorkspaceRestoreReconciled(): Promise<void> {
  if (!reconcilePromise) {
    const exclusive = getWorkspaceExclusiveCapability();
    const recovery = exclusive
      ? reconcileWorkspaceRestoreStateWithAuthority()
      : hasWorkspaceMutationAuthority()
        ? Promise.reject(
            new Error("Startup restore reconciliation cannot begin from a shared mutation lease."),
          )
        : withWorkspaceExclusive("destructive-reconcile", reconcileWorkspaceRestoreStateWithAuthority);
    reconcilePromise = recovery.catch((error) => {
      reconcilePromise = null;
      throw error;
    });
  }
  return reconcilePromise;
}

export function resetWorkspaceRestoreReconcileForTests(): void {
  reconcilePromise = null;
}
