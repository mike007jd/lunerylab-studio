"use client";

/**
 * Authoritative canvas layer state: initial load, agent-driven poll, recovery
 * resync, reconciliation against local dirty writes, and retirement of the
 * write queues the server has proven void.
 *
 * This owner holds server truth (`layers`, `drawingState`, load state) plus the
 * fetch generation and response order that keep an older GET from landing after
 * a newer one. Local write bookkeeping lives in the shared write ledger; the
 * queue mechanisms live in the persistence coordinator, which consumes this
 * owner's recovery entry point.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  createAuthoritativeFetchOwner,
  createAuthoritativeResponseOrder,
  reconcileAuthoritativeCanvasLayers,
} from "@/components/canvas/canvas-authoritative-reconcile";
import type { CanvasCopy } from "@/components/canvas/canvas-copy";
import type { CanvasLayerLockController } from "@/components/canvas/canvas-layer-lock";
import { mapLayers } from "@/components/canvas/canvas-types";
import type {
  LayerGeometryPatch,
  RawLayer,
  SessionResponse,
} from "@/components/canvas/canvas-types";
import type { CanvasWriteLedger } from "@/components/canvas/canvas-write-ledger";
import type { KonvaLayerItem } from "@/components/canvas/konva-stage";
import type { LayerDeletionPreparation } from "@/components/canvas/use-canvas-persistence-coordinator";
import { useCanvasSessionRefresh } from "@/components/canvas/use-canvas-session-refresh";
import type { CanvasDrawingState } from "@/lib/canvas/drawing-state";
import { deleteCanvasLayer, fetchCanvasSession } from "@/lib/client/canvas-sessions";

export interface UseCanvasAuthoritativeSyncArgs {
  sessionId: string;
  ledger: CanvasWriteLedger;
  lockController: CanvasLayerLockController;
  copy: CanvasCopy;
  /** Agent surface is open or streaming — the only reason to poll. */
  pollWhenActive: boolean;
  pollIntervalMs: number;
  /** Selection lives on the page surface; it must release removed layers. */
  onLayersRemoved: (layerIds: readonly string[]) => void;
  /**
   * Persistence-owned delete preflight. Wired from the page via a ref so this
   * owner does not depend on the persistence hook's render identity.
   */
  prepareLayerDeletion: (layerId: string) => Promise<LayerDeletionPreparation>;
  /**
   * Re-queue drained geometry after a failed DELETE leaves the layer present.
   * Same page-boundary ref wiring as prepareLayerDeletion.
   */
  requeueDrainedGeometry: (layerId: string, patch: LayerGeometryPatch) => void;
}

export interface CanvasAuthoritativeSync {
  layers: KonvaLayerItem[];
  drawingState: CanvasDrawingState | undefined;
  loading: boolean;
  error: string | null;
  /** Retry the session fetch without reloading the document. */
  retry: () => void;
  /** Recovery path for a failed optimistic write. */
  resyncLayers: () => void;
  deleteLayer: (layerId: string) => void;
  isLayerLocked: (layerId: string) => boolean;
  setLayerLockedLocally: (layerId: string, locked: boolean) => void;
  /** Publish the newest local annotation snapshot into rendered state. */
  applyLocalDrawingState: (state: CanvasDrawingState) => void;
}

export function useCanvasAuthoritativeSync({
  sessionId,
  ledger,
  lockController,
  copy,
  pollWhenActive,
  pollIntervalMs,
  onLayersRemoved,
  prepareLayerDeletion,
  requeueDrainedGeometry,
}: UseCanvasAuthoritativeSyncArgs): CanvasAuthoritativeSync {
  const [layers, setLayers] = useState<KonvaLayerItem[]>([]);
  const layersRef = useRef<KonvaLayerItem[]>([]);
  const [drawingState, setDrawingState] = useState<CanvasDrawingState | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  // Re-key session loading for retry without a full document reload.
  const [reloadToken, setReloadToken] = useState(0);

  const authoritativeFetchOwnerRef = useRef(createAuthoritativeFetchOwner());
  const [authoritativeResponseOrder] = useState(createAuthoritativeResponseOrder);

  // Latest localized copy for callbacks whose deps stay [sessionId] (re-running
  // on locale change would refetch / churn). Read .current at call time. Updated
  // in an effect (not during render) so the refs-during-render lint stays happy;
  // `copy` only changes identity on a locale switch, so this is effectively idle.
  const copyRef = useRef(copy);
  useEffect(() => {
    copyRef.current = copy;
  }, [copy]);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);
  const onLayersRemovedRef = useRef(onLayersRemoved);
  useEffect(() => {
    onLayersRemovedRef.current = onLayersRemoved;
  }, [onLayersRemoved]);
  const prepareLayerDeletionRef = useRef(prepareLayerDeletion);
  useEffect(() => {
    prepareLayerDeletionRef.current = prepareLayerDeletion;
  }, [prepareLayerDeletion]);
  const requeueDrainedGeometryRef = useRef(requeueDrainedGeometry);
  useEffect(() => {
    requeueDrainedGeometryRef.current = requeueDrainedGeometry;
  }, [requeueDrainedGeometry]);

  const applyAuthoritativeLayers = useCallback(
    (incomingRaw: RawLayer[]) => {
      const incoming = mapLayers(incomingRaw);
      const { nextLayers, serverDeletedDirtyIds } = reconcileAuthoritativeCanvasLayers({
        current: layersRef.current,
        incoming,
        dirtyGeometryIds: ledger.dirtyGeometryIds(),
        pendingCreatedIds: ledger.pendingCreatedIds(),
        pendingDeletedIds: ledger.pendingDeletedIds(),
        acknowledgeAuthoritativeLocks: (layers) =>
          lockController.acknowledgeAuthoritativeLocks(layers),
        lockIntents: lockController.lockIntents,
      });
      if (serverDeletedDirtyIds.length > 0) {
        // The server proved these layers are gone: their queued geometry can
        // never land, so retire the writers before rendering the snapshot.
        ledger.retireLayers(serverDeletedDirtyIds);
        onLayersRemovedRef.current(serverDeletedDirtyIds);
      }
      layersRef.current = nextLayers;
      setLayers(nextLayers);
    },
    [ledger, lockController],
  );

  // Re-sync layer state from the server — used as the recovery path when an
  // optimistic delete, geometry write, or lock write fails (so the UI never
  // drifts from storage). Shares the same reconcile path and response-order
  // authority as polling so a delayed pre-lock poll cannot land after a newer
  // resync.
  const runResync = useCallback(async () => {
    const request = authoritativeFetchOwnerRef.current.begin();
    const orderToken = authoritativeResponseOrder.beginRecovery();
    try {
      const json = await fetchCanvasSession(sessionId, request.signal);
      if (!request.isCurrent() || !orderToken.isCurrent()) return null;
      applyAuthoritativeLayers(json.session.layers);
      return json.session.layers;
    } catch {
      if (request.signal.aborted) return null;
      // Network still down — the save-failed toast already told the user.
      return null;
    } finally {
      orderToken.finish();
    }
  }, [sessionId, applyAuthoritativeLayers, authoritativeResponseOrder]);

  const resyncLayers = useCallback(() => {
    void runResync();
  }, [runResync]);

  useEffect(() => {
    const fetchOwner = authoritativeFetchOwnerRef.current;
    fetchOwner.invalidate();
    authoritativeResponseOrder.invalidate();
    return () => {
      fetchOwner.invalidate();
      authoritativeResponseOrder.invalidate();
    };
  }, [sessionId, authoritativeResponseOrder]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const json = await fetchCanvasSession(sessionId);
        if (cancelled) return;
        setLayers(mapLayers(json.session.layers));
        setDrawingState(json.session.drawingState);
      } catch (err) {
        if (!cancelled) setError((err as Error).message || copyRef.current.loadFailedFallback);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadToken]);

  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    setReloadToken((n) => n + 1);
  }, []);

  // Agent-driven inbound refresh (poll-on-visible). The stage's lastSyncedRef
  // takes care of not stomping on the user's in-flight drag.
  useCanvasSessionRefresh({
    sessionId,
    enabled: !loading && !error && pollWhenActive,
    intervalMs: pollIntervalMs,
    responseOrder: authoritativeResponseOrder,
    onLayers: useCallback((next: RawLayer[]) => {
      applyAuthoritativeLayers(next);
    }, [applyAuthoritativeLayers]),
    onSession: useCallback((session: SessionResponse["session"]) => {
      // Skip the inbound snapshot while local annotations are unsaved, or it
      // would silently delete them (H1). The next successful PATCH clears dirty
      // and the following poll syncs normally.
      if (ledger.isDrawingStateDirty()) return;
      setDrawingState(session.drawingState);
    }, [ledger]),
  });

  const restoreAfterFailedDelete = useCallback(
    async (
      layerId: string,
      localLayer: KonvaLayerItem,
      drainedGeometry: LayerGeometryPatch | null,
    ): Promise<{ confirmedAbsent: boolean; requeue: LayerGeometryPatch | null }> => {
      ledger.rollbackLayerDeleted(layerId);
      const authoritativeLayers = await runResync();
      if (!authoritativeLayers) {
        // The DELETE result is ambiguous and current server truth is
        // unavailable. Restore the local layer instead of interpreting the
        // optimistic absence as authoritative deletion.
        const restored = drainedGeometry
          ? { ...localLayer, ...drainedGeometry }
          : localLayer;
        setLayers((prev) => {
          const withoutDuplicate = prev.filter((layer) => layer.id !== layerId);
          const next = [...withoutDuplicate, restored].sort((left, right) => left.zIndex - right.zIndex);
          layersRef.current = next;
          return next;
        });
        return { confirmedAbsent: false, requeue: drainedGeometry };
      }
      const present = authoritativeLayers.some((layer) => layer.id === layerId);
      if (!present) {
        // Authoritative absence: retire writers only after the server proved
        // the layer is gone — never before DELETE / resync.
        ledger.retireLayers([layerId]);
        return { confirmedAbsent: true, requeue: null };
      }
      if (!drainedGeometry || Object.keys(drainedGeometry).length === 0) {
        return { confirmedAbsent: false, requeue: null };
      }
      setLayers((prev) => {
        const next = prev.map((layer) =>
          layer.id === layerId ? { ...layer, ...drainedGeometry } : layer,
        );
        layersRef.current = next;
        return next;
      });
      return { confirmedAbsent: false, requeue: drainedGeometry };
    },
    [ledger, runResync],
  );

  // User deleted an image layer inside the canvas — persist it so it doesn't
  // resurrect on reload. Optimistic after geometry drain: local state updates
  // immediately, a failed DELETE re-syncs and restores drained geometry.
  const deleteLayer = useCallback(
    (layerId: string) => {
      if (lockController.isInteractionBlocked(layerId)) return;
      if (layersRef.current.find((layer) => layer.id === layerId)?.locked) return;
      void (async () => {
        let preparation: LayerDeletionPreparation;
        try {
          preparation = await prepareLayerDeletionRef.current(layerId);
        } catch {
          toast.error(copyRef.current.toastSaveFailed);
          return;
        }
        if (!preparation.ok) {
          // Drain failed: do not DELETE; persistence queues stay recoverable.
          preparation.release();
          return;
        }
        const drainedGeometry = preparation.drainedGeometry;
        const localLayer = layersRef.current.find((layer) => layer.id === layerId);
        if (!localLayer) {
          preparation.release();
          return;
        }
        let requeue: LayerGeometryPatch | null = null;
        let notifyFailure = false;
        ledger.markLayerDeleted(layerId);
        // Do not retire writers here — only after DELETE success or a resync
        // that proves the layer absent.
        setLayers((prev) => prev.filter((layer) => layer.id !== layerId));
        onLayersRemovedRef.current([layerId]);
        try {
          const resp = await deleteCanvasLayer(sessionId, layerId);
          if (resp.status === 404) {
            // Confirm current server truth instead of treating every 404 as proof
            // the layer stayed absent; a concurrent undo may have re-created it.
            const recovery = await restoreAfterFailedDelete(
              layerId,
              localLayer,
              drainedGeometry,
            );
            requeue = recovery.requeue;
            notifyFailure = !recovery.confirmedAbsent;
          } else if (!resp.ok) {
            throw new Error(`status ${resp.status}`);
          } else {
            ledger.retireLayers([layerId]);
          }
        } catch {
          const recovery = await restoreAfterFailedDelete(
            layerId,
            localLayer,
            drainedGeometry,
          );
          requeue = recovery.requeue;
          notifyFailure = !recovery.confirmedAbsent;
        } finally {
          preparation.release();
        }
        if (notifyFailure) toast.error(copyRef.current.toastDeleteLayerFailed);
        if (requeue && Object.keys(requeue).length > 0) {
          requeueDrainedGeometryRef.current(layerId, requeue);
        }
      })();
    },
    [sessionId, ledger, lockController, restoreAfterFailedDelete],
  );

  const isLayerLocked = useCallback(
    (layerId: string) => Boolean(layersRef.current.find((layer) => layer.id === layerId)?.locked),
    [],
  );

  const setLayerLockedLocally = useCallback((layerId: string, locked: boolean) => {
    // Keep the ref current inside the updater so a queued unlock in the
    // same controller turn does not read a stale unlocked value and no-op.
    setLayers((prev) => {
      const next = prev.map((layer) => (layer.id === layerId ? { ...layer, locked } : layer));
      layersRef.current = next;
      return next;
    });
  }, []);

  const applyLocalDrawingState = useCallback((state: CanvasDrawingState) => {
    setDrawingState(state);
  }, []);

  return {
    layers,
    drawingState,
    loading,
    error,
    retry,
    resyncLayers,
    deleteLayer,
    isLayerLocked,
    setLayerLockedLocally,
    applyLocalDrawingState,
  };
}
