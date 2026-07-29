export const CANVAS_LAYER_LOCK_TIMEOUT_MS = 5_000;

export interface CanvasLayerLockDeps {
  /**
   * Force any debounced geometry for this layer through its serial write queue
   * and resolve true only when the newest patch reached storage. Only a lock
   * transition flushes first; an unlock crosses no geometry boundary.
   */
  flushPendingGeometry: (layerId: string) => Promise<boolean>;
  persistLocked: (
    layerId: string,
    locked: boolean,
    signal: AbortSignal,
  ) => Promise<void>;
  getLocalLocked: (layerId: string) => boolean;
  setLocalLocked: (layerId: string, locked: boolean) => void;
  onFailure: () => void;
  /** Soft notify so React can refresh aria-busy without polling. */
  onTransitionChange?: () => void;
  timeoutMs?: number;
}

export interface CanvasLayerLockController {
  /**
   * (Re)attach the current session-scoped deps. The controller instance is
   * created once per component and outlives any single session binding.
   */
  configure: (deps: CanvasLayerLockDeps) => void;
  /**
   * Bind ownership to a canvas session. Cancels any in-flight transition from
   * a previous session and suppresses its callbacks.
   */
  bindSession: (sessionId: string) => void;
  /** Cancel every transition and detach deps (unmount / session teardown). */
  dispose: () => void;
  toggle: (layerId: string, locked: boolean) => Promise<void>;
  /**
   * Synchronous interaction barrier. True from the first statement of a
   * lock/unlock transition until that transition settles or rolls back.
   */
  isInteractionBlocked: (layerId: string) => boolean;
  /** True while a transition is queued or in flight for the layer. */
  isPending: (layerId: string) => boolean;
  /**
   * True while any current-generation lock transition is queued or in flight.
   * Window-close dirty detection and in-app exit flush must consult this.
   */
  hasPendingTransitions: () => boolean;
  /**
   * Wait for every current-generation lock transition to settle. Resolves
   * `true` only when all complete without failure; session rebind/dispose
   * during the wait resolves `false`. Does not start new transitions.
   */
  awaitPendingTransitions: () => Promise<boolean>;
  /**
   * Presentation / confirmation overlay for lock state.
   *
   * Installed synchronously before the first await of a transition so a stale
   * authoritative snapshot cannot expose an unlocked Konva/row/AT surface.
   * Lock keeps `true` from transition start through confirmation. Unlock keeps
   * `true` until server success, then switches to `false` with local state.
   * Cleared by matching `acknowledgeAuthoritativeLocks` only when that layer
   * has no active barrier, or by failure / session teardown.
   */
  lockIntents: ReadonlyMap<string, boolean>;
  /**
   * Drop intents whose expected lock state appears in an authoritative inbound
   * snapshot. Skips layers with an active transition barrier. Call with the
   * raw server layers before overlaying intents.
   */
  acknowledgeAuthoritativeLocks: (
    layers: ReadonlyArray<{ id: string; locked?: boolean }>,
  ) => void;
}

/**
 * Single authority for user-driven lock/unlock.
 *
 * Lock order: synchronous barrier + presentation locked=true → flush latest
 * geometry (no new edits) → bounded persist → retain intent until poll confirms.
 * Unlock order: synchronous barrier + presentation locked=true → bounded
 * persist → atomically expose unlocked local state and intent=false → retain
 * until poll confirms.
 *
 * Rapid same-layer toggles queue the latest requested state and honor it after
 * the active transition settles. Session rebinds and dispose abort in-flight
 * work and suppress stale callbacks. Running ownership is generation-scoped so
 * an old flush cannot strand a new session on the same layer id.
 */
export function createCanvasLayerLockController(
  initialDeps?: CanvasLayerLockDeps,
): CanvasLayerLockController {
  let deps = initialDeps ?? null;
  let sessionId: string | null = null;
  let sessionGeneration = 0;
  let disposed = false;
  let transitionFailures = 0;

  const barriers = new Set<string>();
  /** layerId → session generation that owns the active runner */
  const running = new Map<string, number>();
  const requested = new Map<string, boolean>();
  const lockIntents = new Map<string, boolean>();
  const abortByLayer = new Map<string, AbortController>();
  const idleWaiters = new Map<string, Array<() => void>>();

  const notify = () => {
    deps?.onTransitionChange?.();
  };

  const isLayerBusy = (layerId: string): boolean =>
    barriers.has(layerId) ||
    requested.has(layerId) ||
    running.get(layerId) === sessionGeneration;

  const resolveIdleWaiters = (layerId: string) => {
    const waiters = idleWaiters.get(layerId);
    if (!waiters || waiters.length === 0) return;
    if (isLayerBusy(layerId)) return;
    idleWaiters.delete(layerId);
    for (const resolve of waiters) resolve();
  };

  const waitForIdle = (layerId: string): Promise<void> => {
    if (!isLayerBusy(layerId)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiters = idleWaiters.get(layerId) ?? [];
      waiters.push(resolve);
      idleWaiters.set(layerId, waiters);
    });
  };

  const collectPendingLayerIds = (): string[] => {
    const ids = new Set<string>([...barriers, ...requested.keys()]);
    for (const [layerId, generation] of running) {
      if (generation === sessionGeneration) ids.add(layerId);
    }
    return [...ids];
  };

  const abortLayer = (layerId: string, reason: string) => {
    const existing = abortByLayer.get(layerId);
    if (!existing) return;
    existing.abort(new DOMException(reason, "AbortError"));
    abortByLayer.delete(layerId);
  };

  const observeLateSettlement = (promise: Promise<unknown>) => {
    void promise.then(
      () => undefined,
      () => undefined,
    );
  };

  const withTimeout = async (
    layerId: string,
    locked: boolean,
    generation: number,
    timeoutMs: number,
  ): Promise<void> => {
    const active = deps;
    if (!active) throw new Error("Canvas layer lock controller has no deps");

    abortLayer(layerId, "Superseded canvas layer lock request");
    const controller = new AbortController();
    abortByLayer.set(layerId, controller);

    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new Error(
      `Canvas layer lock timed out after ${timeoutMs} ms`,
    );
    timeoutError.name = "TimeoutError";
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });

    const persistPromise = active.persistLocked(layerId, locked, controller.signal);
    observeLateSettlement(persistPromise);

    try {
      await Promise.race([persistPromise, timeoutPromise]);
    } catch (error) {
      if (timedOut) throw timeoutError;
      throw error;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (abortByLayer.get(layerId) === controller) {
        abortByLayer.delete(layerId);
      }
    }

    if (disposed || generation !== sessionGeneration) {
      throw new DOMException("Canvas layer lock session changed", "AbortError");
    }
  };

  const isSessionAbort = (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    if (error.name === "TimeoutError") return false;
    return error.name === "AbortError";
  };

  const failTransition = (layerId: string, rollbackLocked?: boolean) => {
    const active = deps;
    if (rollbackLocked !== undefined) {
      active?.setLocalLocked(layerId, rollbackLocked);
    }
    barriers.delete(layerId);
    lockIntents.delete(layerId);
    transitionFailures += 1;
    notify();
    active?.onFailure();
  };

  const runLayer = async (layerId: string, generation: number): Promise<void> => {
    const owner = running.get(layerId);
    if (owner === generation) return;
    if (owner !== undefined && owner > generation) return;
    running.set(layerId, generation);
    try {
      while (!disposed && generation === sessionGeneration && requested.has(layerId)) {
        const target = requested.get(layerId)!;
        requested.delete(layerId);

        const active = deps;
        if (!active) return;

        if (active.getLocalLocked(layerId) === target) {
          continue;
        }

        // Synchronous barrier + presentation override before any await.
        // Overlay protects Konva/row/AT even when a stale GET has no post-PATCH
        // intent yet; barrier still blocks mutation handlers.
        barriers.add(layerId);
        lockIntents.set(layerId, true);
        notify();

        if (target) {
          // Lock: expose locked local state immediately so UI that keys off
          // `layer.locked` matches the barrier for the flush window.
          active.setLocalLocked(layerId, true);
          const flushed = await active.flushPendingGeometry(layerId);
          if (disposed || generation !== sessionGeneration) return;
          if (!flushed) {
            failTransition(layerId, false);
            continue;
          }
          try {
            await withTimeout(
              layerId,
              true,
              generation,
              active.timeoutMs ?? CANVAS_LAYER_LOCK_TIMEOUT_MS,
            );
          } catch (error) {
            if (disposed || generation !== sessionGeneration || isSessionAbort(error)) {
              return;
            }
            failTransition(layerId, false);
            continue;
          }
          if (disposed || generation !== sessionGeneration) return;
          // Intent already true (target) from transition start.
          barriers.delete(layerId);
          notify();
        } else {
          // Unlock: presentation stays locked until the server confirms, then
          // intent and local state flip to false together.
          try {
            await withTimeout(
              layerId,
              false,
              generation,
              active.timeoutMs ?? CANVAS_LAYER_LOCK_TIMEOUT_MS,
            );
          } catch (error) {
            if (disposed || generation !== sessionGeneration || isSessionAbort(error)) {
              return;
            }
            failTransition(layerId);
            continue;
          }
          if (disposed || generation !== sessionGeneration) return;
          active.setLocalLocked(layerId, false);
          lockIntents.set(layerId, false);
          barriers.delete(layerId);
          notify();
        }
      }
    } finally {
      if (running.get(layerId) === generation) {
        if (generation === sessionGeneration) {
          barriers.delete(layerId);
        }
        running.delete(layerId);
        resolveIdleWaiters(layerId);
        // A toggle may have queued work after the loop condition failed but
        // before this generation cleared ownership; restart only for the
        // generation that still owns the session.
        if (
          !disposed &&
          generation === sessionGeneration &&
          requested.has(layerId) &&
          running.get(layerId) !== sessionGeneration
        ) {
          void runLayer(layerId, generation);
        }
      } else {
        resolveIdleWaiters(layerId);
      }
      notify();
    }
  };

  return {
    lockIntents,
    configure(nextDeps) {
      deps = nextDeps;
      disposed = false;
    },
    bindSession(nextSessionId) {
      if (sessionId === nextSessionId && !disposed) return;
      sessionId = nextSessionId;
      sessionGeneration += 1;
      disposed = false;
      for (const layerId of [...abortByLayer.keys()]) {
        abortLayer(layerId, "Canvas session changed");
      }
      barriers.clear();
      requested.clear();
      lockIntents.clear();
      for (const [layerId, waiters] of idleWaiters) {
        idleWaiters.delete(layerId);
        for (const resolve of waiters) resolve();
      }
      notify();
    },
    dispose() {
      disposed = true;
      sessionGeneration += 1;
      sessionId = null;
      for (const layerId of [...abortByLayer.keys()]) {
        abortLayer(layerId, "Canvas layer lock controller disposed");
      }
      barriers.clear();
      requested.clear();
      lockIntents.clear();
      for (const [layerId, waiters] of idleWaiters) {
        idleWaiters.delete(layerId);
        for (const resolve of waiters) resolve();
      }
      deps = null;
      notify();
    },
    async toggle(layerId, locked) {
      if (disposed || !deps || sessionId === null) return;
      const generation = sessionGeneration;
      requested.set(layerId, locked);
      notify();
      void runLayer(layerId, generation);
      await waitForIdle(layerId);
    },
    isInteractionBlocked(layerId) {
      return barriers.has(layerId);
    },
    isPending(layerId) {
      return isLayerBusy(layerId);
    },
    hasPendingTransitions() {
      return collectPendingLayerIds().length > 0;
    },
    async awaitPendingTransitions() {
      if (disposed || sessionId === null) return true;
      const generation = sessionGeneration;
      const failuresBefore = transitionFailures;
      while (
        !disposed &&
        generation === sessionGeneration &&
        collectPendingLayerIds().length > 0
      ) {
        const pending = collectPendingLayerIds();
        await Promise.all(pending.map((layerId) => waitForIdle(layerId)));
      }
      if (disposed || generation !== sessionGeneration) return false;
      return transitionFailures === failuresBefore;
    },
    acknowledgeAuthoritativeLocks(layers) {
      let changed = false;
      for (const layer of layers) {
        // A matching snapshot during flush/PATCH must not drop the override
        // while the transition barrier still owns presentation.
        if (barriers.has(layer.id)) continue;
        const intent = lockIntents.get(layer.id);
        if (intent === undefined) continue;
        if (Boolean(layer.locked) === intent) {
          lockIntents.delete(layer.id);
          changed = true;
        }
      }
      if (changed) notify();
    },
  };
}

export function applyLockIntents<T extends { id: string; locked?: boolean }>(
  layers: readonly T[],
  intents: ReadonlyMap<string, boolean>,
): T[] {
  if (intents.size === 0) return [...layers];
  return layers.map((layer) =>
    intents.has(layer.id) ? { ...layer, locked: intents.get(layer.id) } : layer,
  );
}
