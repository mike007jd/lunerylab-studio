"use client";

/**
 * Canvas persistence coordinator: the single owner of every outbound canvas
 * write.
 *
 * It owns the serialized drawing-state writer, the per-layer debounced geometry
 * writers, the save-status surface, and the flush/exit contract. Dirty and
 * failure bookkeeping lives in the shared write ledger so the authoritative
 * sync owner can reconcile against unsaved work; queue retirement arrives as a
 * ledger event so timers and writers are torn down in the same turn the server
 * proves a layer void.
 *
 * Dependencies point one way: this owner consumes the ledger, the lock
 * controller's barrier, and the sync owner's recovery entry point. It never
 * reads server truth back out of React state.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { canvasExitFailureNotify } from "@/components/canvas/canvas-authoritative-reconcile";
import type { CanvasCopy } from "@/components/canvas/canvas-copy";
import type { CanvasLayerLockController } from "@/components/canvas/canvas-layer-lock";
import {
  PATCH_DEBOUNCE_MS,
  PATCH_MAX_RETRIES,
} from "@/components/canvas/canvas-types";
import type { LayerGeometryPatch } from "@/components/canvas/canvas-types";
import type { CanvasWriteLedger } from "@/components/canvas/canvas-write-ledger";
import {
  bindUnsavedCanvasGuard,
  canClearDirtyGeometry,
  canUseDrawingStateKeepalive,
  deferDrawingQueueDisposal,
} from "@/components/canvas/drawing-state-lifecycle";
import type { KonvaStageHandle } from "@/components/canvas/konva-stage";
import {
  createLatestWriteQueue,
  type LatestWriteQueue,
} from "@/components/canvas/latest-write-queue";
import type { CanvasDrawingState } from "@/lib/canvas/drawing-state";
import { isCanvasLayerLockedError, patchCanvasLayer } from "@/lib/client/canvas-sessions";

interface DrawingStateWrite {
  state: CanvasDrawingState;
  epoch: number;
}

interface LayerPatchWrite {
  patch: LayerGeometryPatch;
}

const CANVAS_WRITE_TIMEOUT_MS = 5_000;
const SAVED_BADGE_HOLD_MS = 1_800;

export type CanvasSaveStatus = "idle" | "saving" | "saved";

export interface UseCanvasPersistenceCoordinatorArgs {
  sessionId: string;
  ledger: CanvasWriteLedger;
  lockController: CanvasLayerLockController;
  stageRef: RefObject<KonvaStageHandle | null>;
  copy: CanvasCopy;
  /** Server-truth lock state; geometry never crosses a locked layer. */
  isLayerLocked: (layerId: string) => boolean;
  /** Publish a local annotation snapshot into rendered state. */
  applyLocalDrawingState: (state: CanvasDrawingState) => void;
  /** Recovery after a write the server terminally rejected. */
  requestAuthoritativeResync: () => void;
}

export interface CanvasPersistenceCoordinator {
  saveStatus: CanvasSaveStatus;
  /** True while an explicit in-app exit is draining writes. */
  exitPending: boolean;
  patchLayerGeometry: (layerId: string, patch: LayerGeometryPatch) => Promise<void>;
  handleDrawingStateChange: (next: CanvasDrawingState) => void;
  handleDrawingStateDirty: () => void;
  /**
   * Force one layer's debounced geometry through its serial writer. The lock
   * controller awaits this before persisting a lock.
   */
  flushPendingGeometry: (layerId: string) => Promise<boolean>;
  /**
   * Drain every channel for an explicit in-app exit. Resolves true only when
   * navigation is safe; failure notifies the user and releases the flag.
   */
  flushForExit: () => Promise<boolean>;
}

export function useCanvasPersistenceCoordinator({
  sessionId,
  ledger,
  lockController,
  stageRef,
  copy,
  isLayerLocked,
  applyLocalDrawingState,
  requestAuthoritativeResync,
}: UseCanvasPersistenceCoordinatorArgs): CanvasPersistenceCoordinator {
  // Latest localized copy for callbacks whose deps stay [sessionId] (re-running
  // on locale change would churn the writers). Read .current at call time.
  const copyRef = useRef(copy);
  useEffect(() => {
    copyRef.current = copy;
  }, [copy]);
  const requestResyncRef = useRef(requestAuthoritativeResync);
  useEffect(() => {
    requestResyncRef.current = requestAuthoritativeResync;
  }, [requestAuthoritativeResync]);

  // Reflect debounced geometry and drawing-state writes without shifting layout.
  const [saveStatus, setSaveStatus] = useState<CanvasSaveStatus>("idle");
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markSavePending = useCallback(() => {
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    setSaveStatus("saving");
  }, []);
  const beginSave = useCallback(() => {
    ledger.beginWrite();
    markSavePending();
  }, [ledger, markSavePending]);
  const endSave = useCallback((succeeded: boolean) => {
    ledger.endWrite();
    if (ledger.inFlightWrites() > 0) return;
    if (!succeeded) {
      setSaveStatus("idle");
      return;
    }
    // Failed or merely debounced writes remain dirty and must never produce
    // a false positive "Saved" badge. Only the newest successful write for
    // every persistence channel clears its dirty marker.
    if (!ledger.canReportSaved()) {
      setSaveStatus("idle");
      return;
    }
    setSaveStatus("saved");
    savedTimerRef.current = setTimeout(() => {
      savedTimerRef.current = null;
      setSaveStatus("idle");
    }, SAVED_BADGE_HOLD_MS);
  }, [ledger]);
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  // One serialized writer owns drawingState persistence. While a request is in
  // flight, repeated edits collapse to the newest state; an older response can
  // therefore never land after and overwrite a newer one.
  const drawingStateSaveQueueRef = useRef<LatestWriteQueue<DrawingStateWrite> | null>(null);
  useEffect(() => {
    const queue = createLatestWriteQueue<DrawingStateWrite>({
      write: async ({ state }, signal) => {
        const body = JSON.stringify({ drawingState: state });
        const response = await fetch(
          `/api/canvas/sessions/${encodeURIComponent(sessionId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body,
            signal,
            // Browser keepalive is limited to small bodies. Oversized snapshots
            // use the normal queue; explicit exits await it and window teardown
            // is blocked while the latest state remains dirty.
            keepalive: canUseDrawingStateKeepalive(body),
          },
        );
        if (!response.ok) throw new Error(`status ${response.status}`);
      },
      maxRetries: PATCH_MAX_RETRIES,
      retryDelayMs: (attempt) => PATCH_DEBOUNCE_MS * Math.min(attempt + 1, 5),
      writeTimeoutMs: CANVAS_WRITE_TIMEOUT_MS,
      onStart: beginSave,
      onSettled: endSave,
      onLatestSaved: ({ epoch }) => {
        ledger.clearDrawingStateDirtyForEpoch(epoch);
      },
      onExhausted: () => {
        toast.error(copyRef.current.toastSaveFailed);
      },
    });
    drawingStateSaveQueueRef.current = queue;
    return () => {
      deferDrawingQueueDisposal(() => {
        queue.close();
        if (drawingStateSaveQueueRef.current === queue) {
          drawingStateSaveQueueRef.current = null;
        }
      });
    };
  }, [sessionId, beginSave, endSave, ledger]);

  // Per-layer debounced geometry persistence. A single drag/resize emits a
  // stream of geometry changes; an immediate PATCH per change would blow past
  // the 60-req/min CRUD limit — and because the response was ignored, 429s and
  // validation failures were swallowed while the optimistic canvas silently
  // diverged from storage. We coalesce to the latest patch per layer, flush
  // after a short idle, check response.ok, and retry with backoff, surfacing a
  // single error toast (not one per write) so layout changes are never lost
  // silently.
  const pendingPatchesRef = useRef<Map<string, LayerGeometryPatch>>(new Map());
  const patchTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const layerPatchQueuesRef = useRef<Map<string, LatestWriteQueue<LayerPatchWrite>>>(new Map());
  // Holds the latest flush implementation so the stable scheduler can call it
  // without a useCallback dependency cycle.
  const flushLayerPatchRef = useRef<((layerId: string) => void) | undefined>(undefined);

  const discardLayerPatchState = useCallback(
    (layerId: string, options?: { closeQueue?: boolean }) => {
      const timer = patchTimersRef.current.get(layerId);
      if (timer) clearTimeout(timer);
      patchTimersRef.current.delete(layerId);
      pendingPatchesRef.current.delete(layerId);
      ledger.clearGeometryDirty(layerId);
      if (options?.closeQueue) {
        layerPatchQueuesRef.current.get(layerId)?.close();
        layerPatchQueuesRef.current.delete(layerId);
      }
    },
    [ledger],
  );

  // Retirement is decided by the authoritative owner (server-deleted dirty
  // layer, user delete) and executed here, because the timers and serial
  // writers are ours.
  useEffect(
    () =>
      ledger.onRetireLayers((layerIds) => {
        for (const layerId of layerIds) {
          const queue = layerPatchQueuesRef.current.get(layerId);
          discardLayerPatchState(layerId);
          // Retirement can race an active PATCH. Void queued values and balance
          // its already-fired onStart as a non-success before forgetting it.
          queue?.retire();
          layerPatchQueuesRef.current.delete(layerId);
        }
      }),
    [ledger, discardLayerPatchState],
  );

  const getLayerPatchQueue = useCallback((layerId: string) => {
    const existing = layerPatchQueuesRef.current.get(layerId);
    if (existing) return existing;

    const queue = createLatestWriteQueue<LayerPatchWrite>({
      write: ({ patch }, signal) => patchCanvasLayer(sessionId, layerId, patch, signal),
      // Geometry updates are partial. If x fails while a newer y is queued,
      // the retry must carry both fields (with the newer value winning) or the
      // failed field is silently lost.
      mergePending: (older, newer) => ({
        patch: { ...older.patch, ...newer.patch },
      }),
      maxRetries: PATCH_MAX_RETRIES,
      retryDelayMs: (attempt) => PATCH_DEBOUNCE_MS * Math.min(attempt + 1, 5),
      writeTimeoutMs: CANVAS_WRITE_TIMEOUT_MS,
      isNonRetryableError: isCanvasLayerLockedError,
      onStart: beginSave,
      onSettled: endSave,
      onLatestSaved: () => {
        // A newer edit can still be waiting in the outer debounce even when
        // the queue itself has no pending value. Keep the layer dirty until
        // that newer patch also reaches storage.
        if (!canClearDirtyGeometry(pendingPatchesRef.current.has(layerId))) return;
        ledger.clearGeometryDirty(layerId);
      },
      onExhausted: (error) => {
        if (isCanvasLayerLockedError(error)) {
          discardLayerPatchState(layerId);
          // The failed queue is terminal and has dropped its pending value.
          // Forget it without closing from inside its callback: close() would
          // suppress this write's onSettled hook and leak the in-flight count.
          // A later edit can then create a fresh queue for the same layer.
          layerPatchQueuesRef.current.delete(layerId);
          toast.error(copyRef.current.toastLockLayerFailed);
          requestResyncRef.current();
          return;
        }
        if (ledger.recordGeometryFailure(layerId)) {
          toast.error(copyRef.current.toastSaveFailed);
        }
      },
    });
    layerPatchQueuesRef.current.set(layerId, queue);
    return queue;
  }, [sessionId, beginSave, endSave, ledger, discardLayerPatchState]);

  const flushLayerPatch = useCallback((layerId: string) => {
    patchTimersRef.current.delete(layerId);
    const patch = pendingPatchesRef.current.get(layerId);
    pendingPatchesRef.current.delete(layerId);
    if (!patch || Object.keys(patch).length === 0) return;
    getLayerPatchQueue(layerId).enqueue({ patch });
  }, [getLayerPatchQueue]);

  useEffect(() => {
    flushLayerPatchRef.current = flushLayerPatch;
  }, [flushLayerPatch]);

  const flushPendingGeometry = useCallback(async (layerId: string) => {
    const timer = patchTimersRef.current.get(layerId);
    if (timer) {
      clearTimeout(timer);
      patchTimersRef.current.delete(layerId);
    }
    flushLayerPatchRef.current?.(layerId);
    const queue = layerPatchQueuesRef.current.get(layerId);
    return queue ? queue.flush() : true;
  }, []);

  const flushAllCanvasWrites = useCallback(async (): Promise<{
    ok: boolean;
    notify: "save" | null;
  }> => {
    stageRef.current?.flushDrawingState();
    for (const timer of patchTimersRef.current.values()) clearTimeout(timer);
    patchTimersRef.current.clear();
    for (const layerId of pendingPatchesRef.current.keys()) flushLayerPatch(layerId);
    pendingPatchesRef.current.clear();

    const queues = [
      ...(drawingStateSaveQueueRef.current ? [drawingStateSaveQueueRef.current] : []),
      ...layerPatchQueuesRef.current.values(),
    ];
    const outcomes = await Promise.all(queues.map((queue) => queue.flush()));
    const queuesOk =
      outcomes.every(Boolean) &&
      !ledger.isDrawingStateDirty() &&
      ledger.dirtyGeometryCount() === 0;
    // Explicit in-app exit awaits bounded lock completion; unmount does not
    // magically persist — dispose aborts, and window close stays guarded.
    const locksOk = await lockController.awaitPendingTransitions();
    return {
      ok: queuesOk && locksOk,
      notify: canvasExitFailureNotify({ locksOk, queuesOk }),
    };
  }, [flushLayerPatch, ledger, lockController, stageRef]);

  // In-app exits wait for drawing/geometry queues and pending lock transitions.
  // Actual window teardown is separately guarded while any channel remains dirty.
  const [exitPending, setExitPending] = useState(false);
  const exitPendingRef = useRef(false);
  const flushForExit = useCallback(async (): Promise<boolean> => {
    if (exitPendingRef.current) return false;
    exitPendingRef.current = true;
    setExitPending(true);
    const result = await flushAllCanvasWrites();
    if (result.ok) return true;
    if (result.notify === "save") {
      toast.error(copyRef.current.toastSaveFailed);
    }
    exitPendingRef.current = false;
    setExitPending(false);
    return false;
  }, [flushAllCanvasWrites]);

  useEffect(
    () =>
      bindUnsavedCanvasGuard({
        windowTarget: window,
        isDirty: () => ledger.isUnloadDirty(Boolean(lockController.hasPendingTransitions())),
      }),
    [ledger, lockController],
  );

  const patchLayerGeometry = useCallback(async (layerId: string, patch: LayerGeometryPatch) => {
    // The lock controller's barrier is the single gate for every mutation path
    // (Konva, keyboard, DOM a11y). Do not admit new geometry once a transition
    // has started — including during the lock flush window.
    if (lockController.isInteractionBlocked(layerId)) return;
    if (isLayerLocked(layerId)) return;
    ledger.markGeometryDirty(layerId);
    markSavePending();
    pendingPatchesRef.current.set(layerId, {
      ...pendingPatchesRef.current.get(layerId),
      ...patch,
    });
    const existing = patchTimersRef.current.get(layerId);
    if (existing) clearTimeout(existing);
    patchTimersRef.current.set(
      layerId,
      setTimeout(() => void flushLayerPatchRef.current?.(layerId), PATCH_DEBOUNCE_MS),
    );
  }, [markSavePending, lockController, ledger, isLayerLocked]);

  // On unmount, flush any pending geometry so a quick navigate-away doesn't drop
  // the last move (keepalive lets the PATCH outlive the page), and clear timers
  // to avoid leaks / setState-after-unmount.
  useEffect(() => {
    const timers = patchTimersRef.current;
    const pending = pendingPatchesRef.current;
    const queues = layerPatchQueuesRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      // Enqueue through the same per-layer serial writer. A direct keepalive
      // request here could overtake an older in-flight PATCH and then be
      // overwritten by that older response.
      for (const layerId of pending.keys()) {
        flushLayerPatchRef.current?.(layerId);
      }
      pending.clear();
      for (const queue of queues.values()) queue.close();
      queues.clear();
    };
  }, [sessionId]);

  const handleDrawingStateChange = useCallback(
    (next: CanvasDrawingState) => {
      // Mark dirty before enqueueing so any poll firing during persistence
      // skips the inbound snapshot.
      ledger.markDrawingStateQueued();
      applyLocalDrawingState(next);
      drawingStateSaveQueueRef.current?.enqueue({
        state: next,
        epoch: ledger.drawingStateEpoch(),
      });
    },
    [ledger, applyLocalDrawingState],
  );

  const handleDrawingStateDirty = useCallback(() => {
    ledger.markDrawingStateEdit();
    markSavePending();
  }, [ledger, markSavePending]);

  return {
    saveStatus,
    exitPending,
    patchLayerGeometry,
    handleDrawingStateChange,
    handleDrawingStateDirty,
    flushPendingGeometry,
    flushForExit,
  };
}
