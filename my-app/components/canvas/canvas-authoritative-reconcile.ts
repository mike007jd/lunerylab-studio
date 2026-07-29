import { applyLockIntents } from "@/components/canvas/canvas-layer-lock";
import {
  findServerDeletedDirtyLayerIds,
  mergePolledLayers,
} from "@/components/canvas/drawing-state-lifecycle";

/**
 * One generation-scoped owner for cancellable authoritative fetches (resync).
 * Beginning a new request aborts the previous one; callbacks must consult
 * `isCurrent` so an older GET cannot land after a newer lock or session change.
 */
export function createAuthoritativeFetchOwner() {
  let generation = 0;
  let controller: AbortController | null = null;

  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      generation += 1;
      const token = generation;
      const signal = controller.signal;
      return {
        token,
        signal,
        isCurrent: () => token === generation && !signal.aborted,
      };
    },
    invalidate() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  };
}

export type AuthoritativeFetchOwner = ReturnType<typeof createAuthoritativeFetchOwner>;

/**
 * Session-generation-scoped response order shared by every authoritative poll
 * and recovery resync. Ordering is a plain monotonic sequence per epoch — no
 * wall-clock timestamps.
 *
 * Recovery owns a higher-priority lease: while a current recovery resync is in
 * flight, polls must not claim (and therefore cannot supersede) it. Polls that
 * already claimed before recovery began are still suppressed by newest-wins
 * when recovery bumps the sequence. Multiple recoveries remain newest-wins;
 * finishing an older recovery must not release a newer lease.
 */
export function createAuthoritativeResponseOrder() {
  let sessionEpoch = 0;
  let latestSeq = 0;
  /** Sequence of the active recovery lease, or null when none. */
  let recoveryLeaseSeq: number | null = null;

  const makeToken = (seq: number, epoch: number) => ({
    seq,
    isCurrent: () => sessionEpoch === epoch && latestSeq === seq,
  });

  return {
    /**
     * Claim a recovery-priority lease. Call `finish` in a finally block so the
     * lease clears only when this recovery still owns it.
     */
    beginRecovery() {
      latestSeq += 1;
      const seq = latestSeq;
      const epoch = sessionEpoch;
      recoveryLeaseSeq = seq;
      let finished = false;
      const token = makeToken(seq, epoch);
      return {
        seq,
        isCurrent: () => !finished && token.isCurrent(),
        finish() {
          finished = true;
          if (sessionEpoch === epoch && recoveryLeaseSeq === seq) {
            recoveryLeaseSeq = null;
          }
        },
      };
    },
    /**
     * Claim a poll token, or return null while any recovery lease is active so
     * the poll skips/defers without superseding the in-flight recovery.
     */
    claimPoll() {
      if (recoveryLeaseSeq !== null) return null;
      latestSeq += 1;
      const seq = latestSeq;
      const epoch = sessionEpoch;
      return makeToken(seq, epoch);
    },
    invalidate() {
      sessionEpoch += 1;
      recoveryLeaseSeq = null;
    },
  };
}

export type AuthoritativeResponseOrder = ReturnType<
  typeof createAuthoritativeResponseOrder
>;

/**
 * Route every authoritative layer snapshot (poll + resync) through one path:
 * advance pending create/delete bookkeeping, acknowledge raw locks, merge only
 * dirty geometry, then overlay lock intents. Callers retire dirty queues for
 * `serverDeletedDirtyIds` before or after applying `nextLayers`.
 */
export function reconcileAuthoritativeCanvasLayers<
  T extends { id: string; locked?: boolean },
>(args: {
  current: readonly T[];
  incoming: readonly T[];
  dirtyGeometryIds: ReadonlySet<string>;
  pendingCreatedIds: Set<string>;
  pendingDeletedIds: Set<string>;
  acknowledgeAuthoritativeLocks: (
    layers: ReadonlyArray<{ id: string; locked?: boolean }>,
  ) => void;
  lockIntents: ReadonlyMap<string, boolean>;
}): { nextLayers: T[]; serverDeletedDirtyIds: string[] } {
  const {
    current,
    incoming,
    dirtyGeometryIds,
    pendingCreatedIds,
    pendingDeletedIds,
    acknowledgeAuthoritativeLocks,
    lockIntents,
  } = args;

  const incomingIds = new Set(incoming.map((layer) => layer.id));
  for (const id of [...pendingCreatedIds]) {
    if (incomingIds.has(id)) pendingCreatedIds.delete(id);
  }
  for (const id of [...pendingDeletedIds]) {
    if (!incomingIds.has(id)) pendingDeletedIds.delete(id);
  }

  const serverDeletedDirtyIds = findServerDeletedDirtyLayerIds(
    incoming,
    dirtyGeometryIds,
    pendingCreatedIds,
  );

  // Intents clear only when the raw server snapshot matches. An older GET that
  // still carries the pre-mutation lock cannot drop a completed write.
  acknowledgeAuthoritativeLocks(incoming);

  const merged = mergePolledLayers(current, incoming, dirtyGeometryIds, {
    preserveMissingIds: pendingCreatedIds,
    deletedIds: pendingDeletedIds,
  });

  return {
    nextLayers: applyLockIntents(merged, lockIntents),
    serverDeletedDirtyIds,
  };
}

/** Window-close / unsaved guard: any persistence channel or lock transition. */
export function isCanvasUnloadDirty(args: {
  drawingStateDirty: boolean;
  dirtyGeometryLayers: number;
  inFlightWrites: number;
  pendingLockTransitions: boolean;
}): boolean {
  return (
    args.drawingStateDirty ||
    args.dirtyGeometryLayers > 0 ||
    args.inFlightWrites > 0 ||
    args.pendingLockTransitions
  );
}

/**
 * In-app exit notification after a coordinated flush. Lock failures already
 * surface via the lock controller's onFailure toast; only remaining save
 * failures need the save toast.
 */
export function canvasExitFailureNotify(args: {
  locksOk: boolean;
  queuesOk: boolean;
}): "save" | null {
  if (!args.locksOk) return null;
  if (!args.queuesOk) return "save";
  return null;
}
