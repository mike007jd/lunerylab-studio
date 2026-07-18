import { describe, expect, it } from "vitest";
import {
  canClearDirtyGeometry,
  canReportCanvasSaved,
  canUseDrawingStateKeepalive,
  deferDrawingQueueDisposal,
  bindUnsavedCanvasGuard,
  findServerDeletedDirtyLayerIds,
  mergePolledLayers,
} from "@/components/canvas/drawing-state-lifecycle";

describe("canUseDrawingStateKeepalive", () => {
  it("keeps oversized snapshots off the browser's 64 KiB keepalive path", () => {
    expect(canUseDrawingStateKeepalive("x".repeat(60 * 1024))).toBe(true);
    expect(canUseDrawingStateKeepalive("x".repeat(60 * 1024 + 1))).toBe(false);
  });
});

describe("canReportCanvasSaved", () => {
  it("requires every persistence channel to be settled and clean", () => {
    expect(canReportCanvasSaved({
      inFlightWrites: 0,
      drawingStateDirty: false,
      dirtyGeometryLayers: 0,
    })).toBe(true);
    expect(canReportCanvasSaved({
      inFlightWrites: 0,
      drawingStateDirty: false,
      dirtyGeometryLayers: 1,
    })).toBe(false);
    expect(canReportCanvasSaved({
      inFlightWrites: 0,
      drawingStateDirty: true,
      dirtyGeometryLayers: 0,
    })).toBe(false);
    expect(canReportCanvasSaved({
      inFlightWrites: 1,
      drawingStateDirty: false,
      dirtyGeometryLayers: 0,
    })).toBe(false);
  });

  it("keeps geometry dirty while a newer edit is still debounced", () => {
    expect(canClearDirtyGeometry(true)).toBe(false);
    expect(canClearDirtyGeometry(false)).toBe(true);
  });
});

describe("canvas lifecycle safety", () => {
  it("defers parent queue disposal until child passive cleanup can flush", async () => {
    const events: string[] = [];

    deferDrawingQueueDisposal(() => events.push("parent-dispose"));
    events.push("child-flush");

    expect(events).toEqual(["child-flush"]);
    await Promise.resolve();
    expect(events).toEqual(["child-flush", "parent-dispose"]);
  });

  it("preserves locally dirty geometry while accepting clean server updates", () => {
    const current = [
      { id: "dirty", x: 9 },
      { id: "clean", x: 1 },
      { id: "new-local", x: 7 },
    ];
    const incoming = [
      { id: "dirty", x: 0 },
      { id: "clean", x: 2 },
    ];
    expect(mergePolledLayers(current, incoming, new Set(["dirty", "new-local"]), {
      preserveMissingIds: new Set(["new-local"]),
    })).toEqual([
      { id: "dirty", x: 9 },
      { id: "clean", x: 2 },
      { id: "new-local", x: 7 },
    ]);
  });

  it("keeps a pending local delete hidden from a stale poll", () => {
    const current = [{ id: "keep", x: 1 }];
    const incoming = [
      { id: "keep", x: 2 },
      { id: "deleting", x: 3 },
    ];

    expect(mergePolledLayers(current, incoming, new Set(), {
      deletedIds: new Set(["deleting"]),
    })).toEqual([{ id: "keep", x: 2 }]);
  });

  it("drops a dirty layer missing from the server unless it is a pending create", () => {
    const ghost = [{ id: "ghost", x: 9 }];
    const dirtyIds = new Set(["ghost"]);

    expect(mergePolledLayers(ghost, [], dirtyIds)).toEqual([]);
    expect(mergePolledLayers(ghost, [], dirtyIds, {
      preserveMissingIds: new Set(["ghost"]),
    })).toEqual(ghost);
  });

  it("preserves a clean pending create until a poll confirms it", () => {
    const created = [{ id: "created", x: 4 }];

    expect(mergePolledLayers(created, [], new Set(), {
      preserveMissingIds: new Set(["created"]),
    })).toEqual(created);
  });

  it("identifies dirty server deletions so their save queues can be retired", () => {
    expect(findServerDeletedDirtyLayerIds(
      [{ id: "still-there" }],
      new Set(["still-there", "ghost", "pending-create"]),
      new Set(["pending-create"]),
    )).toEqual(["ghost"]);
  });

  it("blocks silent unload only while canvas writes are dirty", () => {
    const windowTarget = new EventTarget();
    let dirty = true;
    const cleanup = bindUnsavedCanvasGuard({ windowTarget, isDirty: () => dirty });
    const blocked = new Event("beforeunload", { cancelable: true });
    windowTarget.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);

    dirty = false;
    const clean = new Event("beforeunload", { cancelable: true });
    windowTarget.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    cleanup();
  });
});
