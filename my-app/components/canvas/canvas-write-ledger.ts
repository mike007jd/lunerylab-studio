import { isCanvasUnloadDirty } from "@/components/canvas/canvas-authoritative-reconcile";
import { canReportCanvasSaved } from "@/components/canvas/drawing-state-lifecycle";

/**
 * Single owner of the canvas write bookkeeping that the persistence
 * coordinator and the authoritative sync owner both have to agree on:
 * which channels are dirty, which layers failed, which layers are locally
 * created/deleted, and how many requests are in flight.
 *
 * Persistence owns the mechanisms (timers, serial write queues); sync owns the
 * server truth. Neither may keep its own private copy of these facts, or a
 * poll could clobber unsaved work — so both read and mutate this ledger and
 * nothing else. Retirement is a ledger event: sync decides a layer's local
 * writes are void, the ledger drops its bookkeeping and notifies the queue
 * owner so timers and serial writers are torn down in the same turn.
 */
export interface CanvasWriteLedger {
  /** In-flight persistence requests across every channel. */
  beginWrite: () => void;
  endWrite: () => void;
  inFlightWrites: () => number;

  /**
   * The stage reported a fresh local annotation edit. Advances the epoch so a
   * response for an older snapshot cannot clear the dirty marker.
   */
  markDrawingStateEdit: () => void;
  /** A snapshot was handed to the serial writer; still unsaved. */
  markDrawingStateQueued: () => void;
  drawingStateEpoch: () => number;
  isDrawingStateDirty: () => boolean;
  /** Clears dirty only when `epoch` is still the newest local edit. */
  clearDrawingStateDirtyForEpoch: (epoch: number) => void;

  markGeometryDirty: (layerId: string) => void;
  /** Layer geometry reached storage (or was voided): drop dirty + failure. */
  clearGeometryDirty: (layerId: string) => void;
  /** Live view — reconciliation reads it synchronously while merging. */
  dirtyGeometryIds: () => ReadonlySet<string>;
  dirtyGeometryCount: () => number;
  /** Records a terminal geometry failure; true when the user needs a toast. */
  recordGeometryFailure: (layerId: string) => boolean;

  /** Mutable on purpose: reconciliation advances these while merging. */
  pendingCreatedIds: () => Set<string>;
  pendingDeletedIds: () => Set<string>;
  markLayerDeleted: (layerId: string) => void;
  rollbackLayerDeleted: (layerId: string) => void;

  /**
   * Drop every local write claim for these layers and notify the queue owner.
   * Used when the server proves a locally dirty layer is gone and when the
   * user deletes a layer.
   */
  retireLayers: (layerIds: readonly string[]) => void;
  onRetireLayers: (listener: (layerIds: readonly string[]) => void) => () => void;

  /** True only when every channel is clean and nothing is in flight. */
  canReportSaved: () => boolean;
  isUnloadDirty: (pendingLockTransitions: boolean) => boolean;
}

export function createCanvasWriteLedger(): CanvasWriteLedger {
  let inFlightWrites = 0;
  let drawingStateDirty = false;
  let drawingStateEpoch = 0;
  const dirtyGeometryLayers = new Set<string>();
  const geometrySaveFailures = new Set<string>();
  const pendingCreatedIds = new Set<string>();
  const pendingDeletedIds = new Set<string>();
  const retireListeners = new Set<(layerIds: readonly string[]) => void>();

  return {
    beginWrite() {
      inFlightWrites += 1;
    },
    endWrite() {
      inFlightWrites = Math.max(0, inFlightWrites - 1);
    },
    inFlightWrites: () => inFlightWrites,

    markDrawingStateEdit() {
      drawingStateDirty = true;
      drawingStateEpoch += 1;
    },
    markDrawingStateQueued() {
      drawingStateDirty = true;
    },
    drawingStateEpoch: () => drawingStateEpoch,
    isDrawingStateDirty: () => drawingStateDirty,
    clearDrawingStateDirtyForEpoch(epoch) {
      // A canvas edit may already be waiting inside the stage's debounce and
      // therefore not be visible to the network queue yet.
      if (drawingStateEpoch !== epoch) return;
      drawingStateDirty = false;
    },

    markGeometryDirty(layerId) {
      dirtyGeometryLayers.add(layerId);
    },
    clearGeometryDirty(layerId) {
      dirtyGeometryLayers.delete(layerId);
      geometrySaveFailures.delete(layerId);
    },
    dirtyGeometryIds: () => dirtyGeometryLayers,
    dirtyGeometryCount: () => dirtyGeometryLayers.size,
    recordGeometryFailure(layerId) {
      // One toast per failure streak, not one per failed layer write.
      const shouldNotify = geometrySaveFailures.size === 0;
      geometrySaveFailures.add(layerId);
      return shouldNotify;
    },

    pendingCreatedIds: () => pendingCreatedIds,
    pendingDeletedIds: () => pendingDeletedIds,
    markLayerDeleted(layerId) {
      pendingCreatedIds.delete(layerId);
      pendingDeletedIds.add(layerId);
    },
    rollbackLayerDeleted(layerId) {
      pendingDeletedIds.delete(layerId);
    },

    retireLayers(layerIds) {
      if (layerIds.length === 0) return;
      for (const layerId of layerIds) {
        dirtyGeometryLayers.delete(layerId);
        geometrySaveFailures.delete(layerId);
      }
      for (const listener of [...retireListeners]) listener(layerIds);
    },
    onRetireLayers(listener) {
      retireListeners.add(listener);
      return () => {
        retireListeners.delete(listener);
      };
    },

    canReportSaved: () =>
      canReportCanvasSaved({
        inFlightWrites,
        drawingStateDirty,
        dirtyGeometryLayers: dirtyGeometryLayers.size,
      }),
    isUnloadDirty: (pendingLockTransitions) =>
      isCanvasUnloadDirty({
        drawingStateDirty,
        dirtyGeometryLayers: dirtyGeometryLayers.size,
        inFlightWrites,
        pendingLockTransitions,
      }),
  };
}
