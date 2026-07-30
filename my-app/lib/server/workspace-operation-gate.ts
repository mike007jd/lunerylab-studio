import "server-only";

import { ApiError } from "@/lib/server/errors";

/**
 * Process-wide admission gate for workspace backup/restore versus detached
 * video work. Backup and restore take exclusive ownership; each active video
 * job holds a counted admission slot. The two classes never interleave.
 */

export type WorkspaceExclusiveOperation = "backup" | "restore";

interface GateState {
  exclusive: WorkspaceExclusiveOperation | null;
  activeVideoCount: number;
}

interface GateRuntime {
  state: GateState;
  validDetachedVideoAdmissions: WeakSet<object>;
}

const DETACHED_VIDEO_ADMISSION: unique symbol = Symbol("lunery.detachedVideoAdmission");
const WORKSPACE_GATE_RUNTIME = "__luneryWorkspaceOperationGateRuntimeV1" as const;
const processGlobal = globalThis as typeof globalThis & {
  [WORKSPACE_GATE_RUNTIME]?: GateRuntime;
};
const runtime =
  processGlobal[WORKSPACE_GATE_RUNTIME] ??
  {
    state: {
      exclusive: null,
      activeVideoCount: 0,
    },
    validDetachedVideoAdmissions: new WeakSet<object>(),
  };
processGlobal[WORKSPACE_GATE_RUNTIME] = runtime;
const state = runtime.state;

/**
 * Unforgeable admission handle. Callers must obtain it via
 * `beginDetachedVideoWork` and transfer the object into `runVideoJob`; a bare
 * boolean cannot satisfy the runner.
 */
export interface DetachedVideoAdmission {
  readonly [DETACHED_VIDEO_ADMISSION]: true;
  release(): void;
}

function workspaceBusy(message: string): never {
  throw new ApiError({
    status: 409,
    code: "workspace_busy",
    message,
    retryable: true,
  });
}

export function getWorkspaceOperationGateStateForTests(): Readonly<GateState> {
  return { exclusive: state.exclusive, activeVideoCount: state.activeVideoCount };
}

export function resetWorkspaceOperationGateForTests(): void {
  state.exclusive = null;
  state.activeVideoCount = 0;
  runtime.validDetachedVideoAdmissions = new WeakSet<object>();
}

export function isDetachedVideoAdmission(value: unknown): value is DetachedVideoAdmission {
  return (
    typeof value === "object" &&
    value !== null &&
    runtime.validDetachedVideoAdmissions.has(value)
  );
}

/**
 * Acquire exclusive backup/restore ownership. Rejects with 409 when another
 * exclusive operation is held or any detached video job is still active.
 */
export function acquireWorkspaceExclusive(
  operation: WorkspaceExclusiveOperation,
): () => void {
  if (state.exclusive !== null || state.activeVideoCount > 0) {
    workspaceBusy(
      state.exclusive !== null
        ? `A workspace ${state.exclusive} operation is already in progress.`
        : "A detached video generation is still active.",
    );
  }
  state.exclusive = operation;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (state.exclusive === operation) {
      state.exclusive = null;
    }
  };
}

/**
 * Acquire one detached-video admission slot. Rejects with 409 while backup or
 * restore owns exclusivity. Callers must transfer the handle into the runner
 * and release exactly once on every success, failure, cached, and terminal path.
 */
export function beginDetachedVideoWork(): DetachedVideoAdmission {
  if (state.exclusive !== null) {
    workspaceBusy(
      `Workspace ${state.exclusive} owns exclusivity; video generation cannot start.`,
    );
  }
  state.activeVideoCount += 1;
  let released = false;
  const admission: DetachedVideoAdmission = {
    [DETACHED_VIDEO_ADMISSION]: true,
    release() {
      if (released) return;
      released = true;
      runtime.validDetachedVideoAdmissions.delete(admission);
      state.activeVideoCount = Math.max(0, state.activeVideoCount - 1);
    },
  };
  runtime.validDetachedVideoAdmissions.add(admission);
  return admission;
}

export async function withWorkspaceExclusive<T>(
  operation: WorkspaceExclusiveOperation,
  work: () => Promise<T>,
): Promise<T> {
  const release = acquireWorkspaceExclusive(operation);
  try {
    return await work();
  } finally {
    release();
  }
}
