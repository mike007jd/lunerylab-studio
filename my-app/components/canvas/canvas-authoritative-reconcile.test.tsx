import { describe, expect, it, vi } from "vitest";
import {
  canvasExitFailureNotify,
  createAuthoritativeFetchOwner,
  createAuthoritativeResponseOrder,
  isCanvasUnloadDirty,
  reconcileAuthoritativeCanvasLayers,
} from "@/components/canvas/canvas-authoritative-reconcile";
import {
  applyLockIntents,
  createCanvasLayerLockController,
} from "@/components/canvas/canvas-layer-lock";

describe("reconcileAuthoritativeCanvasLayers", () => {
  it("acknowledges raw locks, merges dirty geometry, and overlays intents", () => {
    const acknowledge = vi.fn();
    const intents = new Map<string, boolean>([["layer-1", true]]);
    const pendingCreatedIds = new Set<string>(["created"]);
    const pendingDeletedIds = new Set<string>(["gone"]);

    const { nextLayers, serverDeletedDirtyIds } = reconcileAuthoritativeCanvasLayers({
      current: [
        { id: "layer-1", locked: true, x: 9, y: 9 },
        { id: "created", locked: false, x: 1, y: 1 },
        { id: "ghost", locked: false, x: 2, y: 2 },
      ],
      incoming: [
        { id: "layer-1", locked: false, x: 0, y: 0 },
        { id: "created", locked: false, x: 3, y: 3 },
      ],
      dirtyGeometryIds: new Set(["layer-1", "ghost"]),
      pendingCreatedIds,
      pendingDeletedIds,
      acknowledgeAuthoritativeLocks: acknowledge,
      lockIntents: intents,
    });

    expect(acknowledge).toHaveBeenCalledWith([
      { id: "layer-1", locked: false, x: 0, y: 0 },
      { id: "created", locked: false, x: 3, y: 3 },
    ]);
    // Stale unlocked GET must not clear the completed lock intent.
    expect(intents.get("layer-1")).toBe(true);
    expect(nextLayers).toEqual([
      { id: "layer-1", locked: true, x: 9, y: 9 },
      { id: "created", locked: false, x: 3, y: 3 },
    ]);
    expect(serverDeletedDirtyIds).toEqual(["ghost"]);
    expect(pendingCreatedIds.size).toBe(0);
    expect(pendingDeletedIds.size).toBe(0);
  });

  it("clears intents only when the raw snapshot matches", async () => {
    const lockController = createCanvasLayerLockController({
      flushPendingGeometry: async () => true,
      persistLocked: async () => {},
      getLocalLocked: () => false,
      setLocalLocked: () => {},
      onFailure: () => {},
    });
    lockController.bindSession("session-1");
    await lockController.toggle("layer-1", true);
    expect(lockController.lockIntents.get("layer-1")).toBe(true);

    reconcileAuthoritativeCanvasLayers({
      current: [{ id: "layer-1", locked: true, x: 1 }],
      incoming: [{ id: "layer-1", locked: true, x: 0 }],
      dirtyGeometryIds: new Set(),
      pendingCreatedIds: new Set(),
      pendingDeletedIds: new Set(),
      acknowledgeAuthoritativeLocks: (layers) =>
        lockController.acknowledgeAuthoritativeLocks(layers),
      lockIntents: lockController.lockIntents,
    });
    expect(lockController.lockIntents.size).toBe(0);
  });
});

describe("createAuthoritativeFetchOwner", () => {
  it("suppresses stale session callbacks after a newer begin or invalidate", () => {
    const owner = createAuthoritativeFetchOwner();
    const first = owner.begin();
    expect(first.isCurrent()).toBe(true);

    const second = owner.begin();
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(first.signal.aborted).toBe(true);

    owner.invalidate();
    expect(second.isCurrent()).toBe(false);
  });
});

describe("createAuthoritativeResponseOrder", () => {
  it("rejects a delayed pre-lock poll after a newer post-lock resync clears intent", async () => {
    const order = createAuthoritativeResponseOrder();
    const lockController = createCanvasLayerLockController({
      flushPendingGeometry: async () => true,
      persistLocked: async () => {},
      getLocalLocked: () => false,
      setLocalLocked: () => {},
      onFailure: () => {},
    });
    lockController.bindSession("session-1");

    // Poll A starts before the lock transition completes.
    const pollA = order.claimPoll();
    expect(pollA).not.toBeNull();
    await lockController.toggle("layer-1", true);
    expect(lockController.lockIntents.get("layer-1")).toBe(true);

    // Recovery B starts after the lock and returns the matching locked snapshot.
    const resyncB = order.beginRecovery();
    expect(pollA!.isCurrent()).toBe(false);
    expect(resyncB.isCurrent()).toBe(true);

    let presentation = [{ id: "layer-1", locked: true as boolean }];
    if (resyncB.isCurrent()) {
      const { nextLayers } = reconcileAuthoritativeCanvasLayers({
        current: presentation,
        incoming: [{ id: "layer-1", locked: true }],
        dirtyGeometryIds: new Set(),
        pendingCreatedIds: new Set(),
        pendingDeletedIds: new Set(),
        acknowledgeAuthoritativeLocks: (layers) =>
          lockController.acknowledgeAuthoritativeLocks(layers),
        lockIntents: lockController.lockIntents,
      });
      presentation = nextLayers;
    }
    expect(lockController.lockIntents.size).toBe(0);
    expect(presentation[0]?.locked).toBe(true);

    // Delayed poll A (pre-lock unlocked) must not reconcile or re-unlock.
    if (pollA!.isCurrent()) {
      const { nextLayers } = reconcileAuthoritativeCanvasLayers({
        current: presentation,
        incoming: [{ id: "layer-1", locked: false }],
        dirtyGeometryIds: new Set(),
        pendingCreatedIds: new Set(),
        pendingDeletedIds: new Set(),
        acknowledgeAuthoritativeLocks: (layers) =>
          lockController.acknowledgeAuthoritativeLocks(layers),
        lockIntents: lockController.lockIntents,
      });
      presentation = nextLayers;
    }

    expect(pollA!.isCurrent()).toBe(false);
    expect(presentation[0]?.locked).toBe(true);
    // Intents were cleared by B; only response-order rejection kept A out.
    expect(lockController.lockIntents.size).toBe(0);
    expect(
      applyLockIntents(presentation, lockController.lockIntents)[0]?.locked,
    ).toBe(true);
    resyncB.finish();
  });

  it("applies the newest recovery and invalidates prior tokens on session change", () => {
    const order = createAuthoritativeResponseOrder();
    const first = order.beginRecovery();
    const second = order.beginRecovery();

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);

    const applied: boolean[] = [];
    if (second.isCurrent()) applied.push(true);
    if (first.isCurrent()) applied.push(false);
    expect(applied).toEqual([true]);

    order.invalidate();
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(false);

    const third = order.claimPoll();
    expect(third).not.toBeNull();
    expect(third!.isCurrent()).toBe(true);
    expect(second.isCurrent()).toBe(false);
  });

  it("denies poll claims while recovery is active and restores after finish", () => {
    const order = createAuthoritativeResponseOrder();
    const recovery = order.beginRecovery();
    expect(order.claimPoll()).toBeNull();
    expect(recovery.isCurrent()).toBe(true);

    recovery.finish();
    expect(recovery.isCurrent()).toBe(false);
    const poll = order.claimPoll();
    expect(poll).not.toBeNull();
    expect(poll!.isCurrent()).toBe(true);
  });

  it("keeps the newer recovery lease when an older resync finishes", () => {
    const order = createAuthoritativeResponseOrder();
    const older = order.beginRecovery();
    const newer = order.beginRecovery();
    expect(older.isCurrent()).toBe(false);
    expect(newer.isCurrent()).toBe(true);

    older.finish();
    expect(order.claimPoll()).toBeNull();
    expect(newer.isCurrent()).toBe(true);

    newer.finish();
    expect(order.claimPoll()).not.toBeNull();
  });

  it("clears the recovery lease on session invalidate", () => {
    const order = createAuthoritativeResponseOrder();
    const recovery = order.beginRecovery();
    expect(order.claimPoll()).toBeNull();

    order.invalidate();
    expect(recovery.isCurrent()).toBe(false);
    expect(order.claimPoll()).not.toBeNull();
  });
});

describe("canvas exit/unload coordination helpers", () => {
  it("treats pending lock transitions as unload-dirty", () => {
    expect(
      isCanvasUnloadDirty({
        drawingStateDirty: false,
        dirtyGeometryLayers: 0,
        inFlightWrites: 0,
        pendingLockTransitions: true,
      }),
    ).toBe(true);
    expect(
      isCanvasUnloadDirty({
        drawingStateDirty: false,
        dirtyGeometryLayers: 0,
        inFlightWrites: 0,
        pendingLockTransitions: false,
      }),
    ).toBe(false);
  });

  it("surfaces only the save toast when locks already notified failure", () => {
    expect(canvasExitFailureNotify({ locksOk: false, queuesOk: true })).toBe(null);
    expect(canvasExitFailureNotify({ locksOk: true, queuesOk: false })).toBe("save");
    expect(canvasExitFailureNotify({ locksOk: true, queuesOk: true })).toBe(null);
  });
});
