import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError } from "@/lib/server/errors";

/**
 * Process-wide workspace mutation admission.
 *
 * Ordinary DB/file writers hold a counted shared lease. Backup, restore, and
 * destructive reconcile take exclusive ownership: they block new shared
 * entrants and wait for existing shared holders to drain. Restore/reconcile
 * internal work runs under an unforgeable exclusive capability in async
 * context so nested Prisma/file mutations cannot self-deadlock.
 */

export type WorkspaceExclusiveOperation =
  | "backup"
  | "restore"
  | "destructive-reconcile"
  | "provider-unlink";

interface GateState {
  exclusive: WorkspaceExclusiveOperation | null;
  exclusivePending: boolean;
  sharedCount: number;
  activeVideoCount: number;
}

type WorkspaceAuthority =
  | { kind: "shared"; token: object }
  | { kind: "exclusive"; operation: WorkspaceExclusiveOperation; capability: ExclusiveCapability };

interface GateRuntime {
  state: GateState;
  authorityStorage: AsyncLocalStorage<WorkspaceAuthority>;
  validDetachedVideoAdmissions: WeakSet<object>;
  detachedVideoAuthorities: WeakMap<object, object>;
  validExclusiveCapabilities: WeakSet<object>;
  validSharedAuthorities: WeakSet<object>;
  drainWaiters: Array<() => void>;
}

const DETACHED_VIDEO_ADMISSION: unique symbol = Symbol("lunery.detachedVideoAdmission");
const EXCLUSIVE_CAPABILITY: unique symbol = Symbol("lunery.workspaceExclusiveCapability");
const WORKSPACE_GATE_RUNTIME = "__luneryWorkspaceOperationGateRuntimeV5" as const;

const processGlobal = globalThis as typeof globalThis & {
  [WORKSPACE_GATE_RUNTIME]?: GateRuntime;
};
const runtime =
  processGlobal[WORKSPACE_GATE_RUNTIME] ??
  {
    state: {
      exclusive: null,
      exclusivePending: false,
      sharedCount: 0,
      activeVideoCount: 0,
    },
    authorityStorage: new AsyncLocalStorage<WorkspaceAuthority>(),
    validDetachedVideoAdmissions: new WeakSet<object>(),
    detachedVideoAuthorities: new WeakMap<object, object>(),
    validExclusiveCapabilities: new WeakSet<object>(),
    validSharedAuthorities: new WeakSet<object>(),
    drainWaiters: [],
  };
processGlobal[WORKSPACE_GATE_RUNTIME] = runtime;
const state = runtime.state;
// Next can compile server routes into separate module instances. The ALS must
// live beside the process-wide counters/WeakSets or exclusive authority from
// one bundle is invisible to Prisma/storage code loaded by another bundle.
const authorityStorage = runtime.authorityStorage;

/**
 * Unforgeable admission handle. Callers must obtain it via
 * `beginDetachedVideoWork` and transfer the object into `runVideoJob`; a bare
 * boolean cannot satisfy the runner.
 */
export interface DetachedVideoAdmission {
  readonly [DETACHED_VIDEO_ADMISSION]: true;
  release(): void;
}

/**
 * Unforgeable exclusive ownership token. Nested restore/reconcile DB and file
 * work must observe this via async context; callers cannot mint one.
 */
export interface ExclusiveCapability {
  readonly [EXCLUSIVE_CAPABILITY]: true;
  readonly operation: WorkspaceExclusiveOperation;
}

function workspaceBusy(message: string): never {
  throw new ApiError({
    status: 409,
    code: "workspace_busy",
    message,
    retryable: true,
  });
}

function notifyDrainWaiters(): void {
  if (state.sharedCount > 0 || runtime.drainWaiters.length === 0) return;
  const waiters = runtime.drainWaiters.splice(0, runtime.drainWaiters.length);
  for (const wake of waiters) wake();
}

function currentAuthority(): WorkspaceAuthority | undefined {
  return authorityStorage.getStore();
}

export function hasWorkspaceMutationAuthority(): boolean {
  const authority = currentAuthority();
  if (authority?.kind === "shared") {
    return runtime.validSharedAuthorities.has(authority.token);
  }
  if (authority?.kind === "exclusive") {
    return runtime.validExclusiveCapabilities.has(authority.capability);
  }
  return false;
}

export function getWorkspaceExclusiveCapability(): ExclusiveCapability | null {
  const authority = currentAuthority();
  if (authority?.kind !== "exclusive") return null;
  if (!runtime.validExclusiveCapabilities.has(authority.capability)) return null;
  return authority.capability;
}

export function getWorkspaceOperationGateStateForTests(): Readonly<GateState> {
  return {
    exclusive: state.exclusive,
    exclusivePending: state.exclusivePending,
    sharedCount: state.sharedCount,
    activeVideoCount: state.activeVideoCount,
  };
}

export function resetWorkspaceOperationGateForTests(): void {
  state.exclusive = null;
  state.exclusivePending = false;
  state.sharedCount = 0;
  state.activeVideoCount = 0;
  runtime.validDetachedVideoAdmissions = new WeakSet<object>();
  runtime.detachedVideoAuthorities = new WeakMap<object, object>();
  runtime.validExclusiveCapabilities = new WeakSet<object>();
  runtime.validSharedAuthorities = new WeakSet<object>();
  runtime.drainWaiters = [];
}

export function isDetachedVideoAdmission(value: unknown): value is DetachedVideoAdmission {
  return (
    typeof value === "object" &&
    value !== null &&
    runtime.validDetachedVideoAdmissions.has(value)
  );
}

function acquireSharedSlot(blockMessage?: string): () => void {
  if (state.exclusive !== null || state.exclusivePending) {
    workspaceBusy(
      blockMessage ??
        (state.exclusive !== null
          ? `Workspace ${state.exclusive} owns exclusivity; mutations cannot start.`
          : "A workspace exclusive operation is starting; mutations cannot start."),
    );
  }
  state.sharedCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.sharedCount = Math.max(0, state.sharedCount - 1);
    notifyDrainWaiters();
  };
}

/**
 * Acquire one shared mutation slot for ordinary DB/logical-file writers.
 * Re-entrant when the current async context already holds shared or exclusive
 * authority.
 */
export async function withSharedMutationLease<T>(work: () => Promise<T>): Promise<T> {
  if (hasWorkspaceMutationAuthority()) {
    return work();
  }
  const release = acquireSharedSlot();
  const token = {};
  runtime.validSharedAuthorities.add(token);
  try {
    return await authorityStorage.run({ kind: "shared", token }, work);
  } finally {
    runtime.validSharedAuthorities.delete(token);
    release();
  }
}

/**
 * Synchronous shared admission for sync config writers (provider metadata).
 * Re-entrant when async context already holds authority.
 */
export function withSharedMutationLeaseSync<T>(work: () => T): T {
  if (hasWorkspaceMutationAuthority()) {
    return work();
  }
  const release = acquireSharedSlot();
  const token = {};
  runtime.validSharedAuthorities.add(token);
  try {
    return authorityStorage.run({ kind: "shared", token }, work);
  } finally {
    runtime.validSharedAuthorities.delete(token);
    release();
  }
}

async function waitForSharedDrain(): Promise<void> {
  if (state.sharedCount === 0) return;
  await new Promise<void>((resolve) => {
    runtime.drainWaiters.push(resolve);
  });
}

/**
 * Acquire exclusive backup/restore/destructive-reconcile ownership.
 * Blocks new shared entrants immediately, then waits for existing shared
 * holders to drain. Rejects when another exclusive operation is already held
 * or pending.
 */
export async function acquireWorkspaceExclusive(
  operation: WorkspaceExclusiveOperation,
): Promise<{ release: () => void; capability: ExclusiveCapability }> {
  if (state.exclusive !== null || state.exclusivePending) {
    workspaceBusy(
      state.exclusive !== null
        ? `A workspace ${state.exclusive} operation is already in progress.`
        : "A workspace exclusive operation is already starting.",
    );
  }

  state.exclusivePending = true;
  try {
    while (state.sharedCount > 0) {
      await waitForSharedDrain();
      if (state.exclusive !== null) {
        workspaceBusy(`A workspace ${state.exclusive} operation is already in progress.`);
      }
    }
    state.exclusive = operation;
    const capability: ExclusiveCapability = {
      [EXCLUSIVE_CAPABILITY]: true,
      operation,
    };
    runtime.validExclusiveCapabilities.add(capability);
    let released = false;
    return {
      capability,
      release: () => {
        if (released) return;
        released = true;
        runtime.validExclusiveCapabilities.delete(capability);
        if (state.exclusive === operation) {
          state.exclusive = null;
        }
        state.exclusivePending = false;
      },
    };
  } catch (error) {
    state.exclusivePending = false;
    throw error;
  }
}

/**
 * Acquire one detached-video admission slot as a long-lived shared lease.
 * Rejects with 409 while backup/restore/destructive-reconcile owns exclusivity.
 */
export function beginDetachedVideoWork(): DetachedVideoAdmission {
  const releaseShared = acquireSharedSlot(
    state.exclusive !== null
      ? `Workspace ${state.exclusive} owns exclusivity; video generation cannot start.`
      : "A workspace exclusive operation is starting; video generation cannot start.",
  );
  state.activeVideoCount += 1;
  const token = {};
  runtime.validSharedAuthorities.add(token);
  let released = false;
  const admission: DetachedVideoAdmission = {
    [DETACHED_VIDEO_ADMISSION]: true,
    release() {
      if (released) return;
      released = true;
      runtime.validDetachedVideoAdmissions.delete(admission);
      runtime.detachedVideoAuthorities.delete(admission);
      runtime.validSharedAuthorities.delete(token);
      state.activeVideoCount = Math.max(0, state.activeVideoCount - 1);
      releaseShared();
    },
  };
  runtime.validDetachedVideoAdmissions.add(admission);
  runtime.detachedVideoAuthorities.set(admission, token);
  return admission;
}

/**
 * Run the full detached job under the shared authority owned by its long-lived
 * admission. This lets already-admitted work finish DB/file settlement while
 * an exclusive operation is pending, but the authority expires on release.
 */
export async function runWithDetachedVideoAdmission<T>(
  admission: DetachedVideoAdmission,
  work: () => Promise<T>,
): Promise<T> {
  const token = runtime.detachedVideoAuthorities.get(admission);
  if (!token || !runtime.validSharedAuthorities.has(token) || !isDetachedVideoAdmission(admission)) {
    workspaceBusy("Detached video workspace admission is not valid.");
  }
  return authorityStorage.run({ kind: "shared", token }, work);
}

export async function withWorkspaceExclusive<T>(
  operation: WorkspaceExclusiveOperation,
  work: () => Promise<T>,
): Promise<T> {
  const { release, capability } = await acquireWorkspaceExclusive(operation);
  try {
    return await authorityStorage.run(
      { kind: "exclusive", operation, capability },
      work,
    );
  } finally {
    release();
  }
}

/**
 * Run work under an already-held exclusive capability. Used when restore or
 * destructive reconcile must cross an await boundary while preserving
 * unforgeable internal authority.
 */
export async function runWithExclusiveCapability<T>(
  capability: ExclusiveCapability,
  work: () => Promise<T>,
): Promise<T> {
  if (!runtime.validExclusiveCapabilities.has(capability)) {
    workspaceBusy("Workspace exclusive capability is not valid.");
  }
  return authorityStorage.run(
    { kind: "exclusive", operation: capability.operation, capability },
    work,
  );
}
