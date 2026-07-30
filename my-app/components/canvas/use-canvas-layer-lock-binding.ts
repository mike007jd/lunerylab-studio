"use client";

/**
 * Binds the session-scoped layer lock controller to its owners and exposes the
 * two things the UI needs: the toggle action and the pending flag.
 *
 * The controller keeps the lock order (synchronous barrier → flush latest
 * geometry → bounded PATCH → retain intent until an authoritative poll
 * confirms). This hook only supplies its dependencies — geometry flushing from
 * the persistence coordinator, local lock state and recovery from the
 * authoritative sync owner — and owns the UI epoch that lets React refresh
 * aria-busy without polling.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { CanvasCopy } from "@/components/canvas/canvas-copy";
import {
  CANVAS_LAYER_LOCK_TIMEOUT_MS,
  type CanvasLayerLockController,
} from "@/components/canvas/canvas-layer-lock";
import { setCanvasLayerLocked } from "@/lib/client/canvas-sessions";

export interface UseCanvasLayerLockBindingArgs {
  sessionId: string;
  lockController: CanvasLayerLockController;
  copy: CanvasCopy;
  flushPendingGeometry: (layerId: string) => Promise<boolean>;
  getLocalLocked: (layerId: string) => boolean;
  setLocalLocked: (layerId: string, locked: boolean) => void;
  requestAuthoritativeResync: () => void;
}

export interface CanvasLayerLockBinding {
  toggleLayerLock: (layerId: string, locked: boolean) => void;
  isLayerLockPending: (layerId: string) => boolean;
}

export function useCanvasLayerLockBinding({
  sessionId,
  lockController,
  copy,
  flushPendingGeometry,
  getLocalLocked,
  setLocalLocked,
  requestAuthoritativeResync,
}: UseCanvasLayerLockBindingArgs): CanvasLayerLockBinding {
  const [lockUiEpoch, setLockUiEpoch] = useState(0);

  // Latest localized copy / recovery entry point without re-binding the
  // controller on a locale change.
  const failureRef = useRef({ copy, requestAuthoritativeResync });
  useEffect(() => {
    failureRef.current = { copy, requestAuthoritativeResync };
  }, [copy, requestAuthoritativeResync]);

  useEffect(() => {
    lockController.bindSession(sessionId);
    lockController.configure({
      flushPendingGeometry,
      persistLocked: (layerId, locked, signal) =>
        setCanvasLayerLocked(sessionId, layerId, locked, signal),
      getLocalLocked,
      setLocalLocked,
      onFailure: () => {
        toast.error(failureRef.current.copy.toastLockLayerFailed);
        failureRef.current.requestAuthoritativeResync();
      },
      onTransitionChange: () => setLockUiEpoch((epoch) => epoch + 1),
      timeoutMs: CANVAS_LAYER_LOCK_TIMEOUT_MS,
    });
    return () => {
      lockController.dispose();
    };
  }, [lockController, sessionId, flushPendingGeometry, getLocalLocked, setLocalLocked]);

  const toggleLayerLock = useCallback(
    (layerId: string, locked: boolean) => {
      void lockController.toggle(layerId, locked);
    },
    [lockController],
  );

  const isLayerLockPending = useCallback(
    (layerId: string) => {
      void lockUiEpoch;
      return lockController.isPending(layerId);
    },
    [lockController, lockUiEpoch],
  );

  return { toggleLayerLock, isLayerLockPending };
}
