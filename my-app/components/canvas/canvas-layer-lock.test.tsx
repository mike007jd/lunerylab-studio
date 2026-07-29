import { describe, expect, it, vi } from "vitest";
import {
  applyLockIntents,
  createCanvasLayerLockController,
  type CanvasLayerLockDeps,
} from "@/components/canvas/canvas-layer-lock";
import { reconcileAuthoritativeCanvasLayers } from "@/components/canvas/canvas-authoritative-reconcile";

function makeDeps(overrides: Partial<CanvasLayerLockDeps> = {}) {
  const lockedById = new Map<string, boolean>();
  return {
    flushPendingGeometry: vi.fn(async () => true),
    persistLocked: vi.fn(async () => {}),
    getLocalLocked: vi.fn((layerId: string) => lockedById.get(layerId) ?? false),
    setLocalLocked: vi.fn((layerId: string, locked: boolean) => {
      lockedById.set(layerId, locked);
    }),
    onFailure: vi.fn(),
    ...overrides,
  } satisfies CanvasLayerLockDeps;
}

function makeController(deps: CanvasLayerLockDeps, sessionId = "session-1") {
  const controller = createCanvasLayerLockController();
  controller.bindSession(sessionId);
  controller.configure(deps);
  return controller;
}

describe("createCanvasLayerLockController", () => {
  it("blocks interaction synchronously before flushing geometry on lock", async () => {
    let releaseFlush!: (ok: boolean) => void;
    const deps = makeDeps({
      flushPendingGeometry: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            releaseFlush = resolve;
          }),
      ),
    });
    const controller = makeController(deps);

    const locking = controller.toggle("layer-1", true);
    expect(controller.isInteractionBlocked("layer-1")).toBe(true);
    expect(controller.lockIntents.get("layer-1")).toBe(true);
    expect(deps.setLocalLocked).toHaveBeenCalledWith("layer-1", true);
    expect(deps.persistLocked).not.toHaveBeenCalled();

    releaseFlush(true);
    await locking;

    expect(deps.flushPendingGeometry).toHaveBeenCalledWith("layer-1");
    expect(deps.persistLocked).toHaveBeenCalledWith(
      "layer-1",
      true,
      expect.any(AbortSignal),
    );
    expect(controller.isInteractionBlocked("layer-1")).toBe(false);
    expect(controller.lockIntents.get("layer-1")).toBe(true);
  });

  it("aborts the lock when geometry never reached storage", async () => {
    const deps = makeDeps({ flushPendingGeometry: vi.fn(async () => false) });
    const controller = makeController(deps);

    await controller.toggle("layer-1", true);

    expect(deps.persistLocked).not.toHaveBeenCalled();
    expect(deps.setLocalLocked).toHaveBeenCalledWith("layer-1", true);
    expect(deps.setLocalLocked).toHaveBeenCalledWith("layer-1", false);
    expect(deps.onFailure).toHaveBeenCalledTimes(1);
    expect(controller.lockIntents.size).toBe(0);
    expect(controller.isInteractionBlocked("layer-1")).toBe(false);
  });

  it("keeps unlock blocked until the server confirms", async () => {
    let releasePersist!: () => void;
    const deps = makeDeps({
      getLocalLocked: vi.fn(() => true),
      persistLocked: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releasePersist = resolve;
          }),
      ),
    });
    const controller = makeController(deps);

    const unlocking = controller.toggle("layer-1", false);
    await Promise.resolve();

    expect(controller.isInteractionBlocked("layer-1")).toBe(true);
    expect(controller.lockIntents.get("layer-1")).toBe(true);
    expect(deps.setLocalLocked).not.toHaveBeenCalled();
    expect(deps.flushPendingGeometry).not.toHaveBeenCalled();

    releasePersist();
    await unlocking;

    expect(deps.setLocalLocked).toHaveBeenCalledWith("layer-1", false);
    expect(controller.lockIntents.get("layer-1")).toBe(false);
    expect(controller.isInteractionBlocked("layer-1")).toBe(false);
  });

  it("rolls a failed unlock back without exposing editable state", async () => {
    const deps = makeDeps({
      getLocalLocked: vi.fn(() => true),
      persistLocked: vi.fn(async () => {
        throw new Error("status 500");
      }),
    });
    const controller = makeController(deps);

    await controller.toggle("layer-1", false);

    expect(deps.setLocalLocked).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledTimes(1);
    expect(controller.isInteractionBlocked("layer-1")).toBe(false);
    expect(controller.lockIntents.size).toBe(0);
  });

  it("rolls the optimistic lock back when the write fails", async () => {
    const deps = makeDeps({
      persistLocked: vi.fn(async () => {
        throw new Error("status 500");
      }),
    });
    const controller = makeController(deps);

    await controller.toggle("layer-1", true);

    expect(vi.mocked(deps.setLocalLocked).mock.calls).toEqual([
      ["layer-1", true],
      ["layer-1", false],
    ]);
    expect(deps.onFailure).toHaveBeenCalledTimes(1);
    expect(controller.lockIntents.size).toBe(0);
  });

  it("retains lock intent after PATCH until an authoritative poll matches", async () => {
    const deps = makeDeps();
    const controller = makeController(deps);

    await controller.toggle("layer-1", true);
    expect(controller.lockIntents.get("layer-1")).toBe(true);

    // Stale GET still unlocked — intent must win.
    controller.acknowledgeAuthoritativeLocks([{ id: "layer-1", locked: false }]);
    expect(controller.lockIntents.get("layer-1")).toBe(true);
    expect(
      applyLockIntents([{ id: "layer-1", locked: false }], controller.lockIntents),
    ).toEqual([{ id: "layer-1", locked: true }]);

    controller.acknowledgeAuthoritativeLocks([{ id: "layer-1", locked: true }]);
    expect(controller.lockIntents.size).toBe(0);
  });

  it("keeps presentation locked when reconciling a stale false snapshot during deferred lock persist", async () => {
    let releasePersist!: () => void;
    const deps = makeDeps({
      persistLocked: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releasePersist = resolve;
          }),
      ),
    });
    const controller = makeController(deps);
    const locking = controller.toggle("layer-1", true);
    await Promise.resolve();

    expect(controller.lockIntents.get("layer-1")).toBe(true);
    expect(controller.isInteractionBlocked("layer-1")).toBe(true);

    const { nextLayers } = reconcileAuthoritativeCanvasLayers({
      current: [{ id: "layer-1", locked: true, x: 1 }],
      incoming: [{ id: "layer-1", locked: false, x: 0 }],
      dirtyGeometryIds: new Set(),
      pendingCreatedIds: new Set(),
      pendingDeletedIds: new Set(),
      acknowledgeAuthoritativeLocks: (layers) =>
        controller.acknowledgeAuthoritativeLocks(layers),
      lockIntents: controller.lockIntents,
    });

    expect(nextLayers[0]?.locked).toBe(true);
    expect(controller.lockIntents.get("layer-1")).toBe(true);

    // Matching true during the barrier must not clear the override either.
    reconcileAuthoritativeCanvasLayers({
      current: nextLayers,
      incoming: [{ id: "layer-1", locked: true, x: 0 }],
      dirtyGeometryIds: new Set(),
      pendingCreatedIds: new Set(),
      pendingDeletedIds: new Set(),
      acknowledgeAuthoritativeLocks: (layers) =>
        controller.acknowledgeAuthoritativeLocks(layers),
      lockIntents: controller.lockIntents,
    });
    expect(controller.lockIntents.get("layer-1")).toBe(true);

    releasePersist();
    await locking;
    expect(controller.lockIntents.get("layer-1")).toBe(true);
    expect(controller.isInteractionBlocked("layer-1")).toBe(false);
  });

  it("keeps presentation locked when reconciling during deferred unlock, then switches intent to false on success", async () => {
    let releasePersist!: () => void;
    const deps = makeDeps({
      getLocalLocked: vi.fn(() => true),
      persistLocked: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releasePersist = resolve;
          }),
      ),
    });
    const controller = makeController(deps);
    const unlocking = controller.toggle("layer-1", false);
    await Promise.resolve();

    expect(controller.lockIntents.get("layer-1")).toBe(true);

    const { nextLayers } = reconcileAuthoritativeCanvasLayers({
      current: [{ id: "layer-1", locked: true, x: 1 }],
      incoming: [{ id: "layer-1", locked: false, x: 0 }],
      dirtyGeometryIds: new Set(),
      pendingCreatedIds: new Set(),
      pendingDeletedIds: new Set(),
      acknowledgeAuthoritativeLocks: (layers) =>
        controller.acknowledgeAuthoritativeLocks(layers),
      lockIntents: controller.lockIntents,
    });

    expect(nextLayers[0]?.locked).toBe(true);
    expect(controller.lockIntents.get("layer-1")).toBe(true);
    expect(deps.setLocalLocked).not.toHaveBeenCalled();

    releasePersist();
    await unlocking;

    expect(deps.setLocalLocked).toHaveBeenCalledWith("layer-1", false);
    expect(controller.lockIntents.get("layer-1")).toBe(false);
  });

  it("removes the presentation override on lock failure", async () => {
    const deps = makeDeps({
      persistLocked: vi.fn(async () => {
        throw new Error("status 500");
      }),
    });
    const controller = makeController(deps);

    const locking = controller.toggle("layer-1", true);
    await Promise.resolve();
    expect(controller.lockIntents.get("layer-1")).toBe(true);
    await locking;

    expect(controller.lockIntents.size).toBe(0);
    expect(deps.onFailure).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "respects abort",
      persistLocked: (_layerId: string, _locked: boolean, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    },
    {
      name: "ignores abort and never settles",
      persistLocked: () => new Promise<void>(() => {}),
    },
  ])("times out a hung lock request when persistLocked $name", async ({ persistLocked }) => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        persistLocked: vi.fn(persistLocked),
        timeoutMs: 50,
      });
      const controller = makeController(deps);

      const locking = controller.toggle("layer-1", true);
      await vi.advanceTimersByTimeAsync(50);
      await locking;

      expect(deps.onFailure).toHaveBeenCalledTimes(1);
      expect(deps.setLocalLocked).toHaveBeenCalledWith("layer-1", false);
      expect(controller.isInteractionBlocked("layer-1")).toBe(false);
      expect(controller.isPending("layer-1")).toBe(false);
      expect(controller.hasPendingTransitions()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes pending transitions for unload/exit coordination", async () => {
    let releasePersist!: () => void;
    const deps = makeDeps({
      persistLocked: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releasePersist = resolve;
          }),
      ),
    });
    const controller = makeController(deps);

    const locking = controller.toggle("layer-1", true);
    await Promise.resolve();
    expect(controller.hasPendingTransitions()).toBe(true);

    releasePersist();
    await locking;
    expect(controller.hasPendingTransitions()).toBe(false);
  });

  it("awaitPendingTransitions returns false when a lock write fails", async () => {
    const deps = makeDeps({
      persistLocked: vi.fn(async () => {
        throw new Error("status 500");
      }),
    });
    const controller = makeController(deps);

    void controller.toggle("layer-1", true);
    await expect(controller.awaitPendingTransitions()).resolves.toBe(false);
    expect(deps.onFailure).toHaveBeenCalledTimes(1);
  });

  it("awaitPendingTransitions returns true after successful transitions", async () => {
    const deps = makeDeps();
    const controller = makeController(deps);

    void controller.toggle("layer-1", true);
    await expect(controller.awaitPendingTransitions()).resolves.toBe(true);
    expect(controller.lockIntents.get("layer-1")).toBe(true);
  });

  it("lets a new session toggle settle while an old-generation flush is still deferred", async () => {
    let releaseOldFlush!: (ok: boolean) => void;
    const oldDeps = makeDeps({
      flushPendingGeometry: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            releaseOldFlush = resolve;
          }),
      ),
    });
    const controller = makeController(oldDeps, "session-1");
    const oldToggle = controller.toggle("layer-1", true);
    await Promise.resolve();
    expect(controller.isInteractionBlocked("layer-1")).toBe(true);

    controller.bindSession("session-2");
    const newDeps = makeDeps();
    controller.configure(newDeps);

    const newToggle = controller.toggle("layer-1", true);
    await newToggle;

    expect(newDeps.persistLocked).toHaveBeenCalledWith(
      "layer-1",
      true,
      expect.any(AbortSignal),
    );
    expect(newDeps.onFailure).not.toHaveBeenCalled();
    expect(controller.lockIntents.get("layer-1")).toBe(true);
    expect(controller.hasPendingTransitions()).toBe(false);

    releaseOldFlush(true);
    await oldToggle;

    expect(newDeps.setLocalLocked).not.toHaveBeenCalledWith("layer-1", false);
    expect(oldDeps.onFailure).not.toHaveBeenCalled();
    expect(newDeps.onFailure).not.toHaveBeenCalled();
    expect(controller.lockIntents.get("layer-1")).toBe(true);
    expect(oldDeps.persistLocked).not.toHaveBeenCalled();
  });

  it("cancels in-flight work on session switch and suppresses stale callbacks", async () => {
    let releasePersist!: () => void;
    const deps = makeDeps({
      persistLocked: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releasePersist = resolve;
          }),
      ),
    });
    const controller = makeController(deps);
    const locking = controller.toggle("layer-1", true);
    await Promise.resolve();

    controller.bindSession("session-2");
    const nextDeps = makeDeps();
    controller.configure(nextDeps);
    releasePersist();
    await locking;

    expect(deps.onFailure).not.toHaveBeenCalled();
    expect(nextDeps.persistLocked).not.toHaveBeenCalled();
    expect(controller.lockIntents.size).toBe(0);
  });

  it("cancels in-flight work on dispose/unmount", async () => {
    let releasePersist!: () => void;
    const deps = makeDeps({
      persistLocked: vi.fn(
        (_layerId, _locked, signal) =>
          new Promise<void>((resolve, reject) => {
            releasePersist = resolve;
            signal.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    });
    const controller = makeController(deps);
    const locking = controller.toggle("layer-1", true);
    await Promise.resolve();
    controller.dispose();
    releasePersist();
    await locking;

    expect(deps.onFailure).not.toHaveBeenCalled();
    expect(controller.isPending("layer-1")).toBe(false);
  });

  it("queues and honors the latest requested state on rapid same-layer toggles", async () => {
    const order: Array<{ locked: boolean }> = [];
    let releaseFirst!: () => void;
    const deps = makeDeps({
      persistLocked: vi.fn(async (_layerId, locked) => {
        order.push({ locked });
        if (order.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      }),
    });
    const controller = makeController(deps);

    const first = controller.toggle("layer-1", true);
    const second = controller.toggle("layer-1", false);
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual([{ locked: true }, { locked: false }]);
    expect(deps.setLocalLocked).toHaveBeenLastCalledWith("layer-1", false);
    expect(controller.lockIntents.get("layer-1")).toBe(false);
  });

  it("still toggles other layers while one layer is in flight", async () => {
    let release!: () => void;
    const deps = makeDeps({
      persistLocked: vi.fn(async (layerId: string) => {
        if (layerId === "layer-1") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      }),
    });
    const controller = makeController(deps);

    const first = controller.toggle("layer-1", true);
    await controller.toggle("layer-2", true);
    release();
    await first;

    expect(deps.persistLocked).toHaveBeenCalledWith(
      "layer-1",
      true,
      expect.any(AbortSignal),
    );
    expect(deps.persistLocked).toHaveBeenCalledWith(
      "layer-2",
      true,
      expect.any(AbortSignal),
    );
  });
});
