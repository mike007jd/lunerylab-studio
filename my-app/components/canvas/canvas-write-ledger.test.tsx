import { describe, expect, it, vi } from "vitest";
import { createCanvasWriteLedger } from "@/components/canvas/canvas-write-ledger";

describe("createCanvasWriteLedger drawing-state channel", () => {
  it("clears dirty only for the newest local edit", () => {
    const ledger = createCanvasWriteLedger();
    ledger.markDrawingStateEdit();
    const staleEpoch = ledger.drawingStateEpoch();

    // A newer stage edit lands while the older snapshot is still in flight.
    ledger.markDrawingStateEdit();
    ledger.clearDrawingStateDirtyForEpoch(staleEpoch);
    expect(ledger.isDrawingStateDirty()).toBe(true);

    ledger.clearDrawingStateDirtyForEpoch(ledger.drawingStateEpoch());
    expect(ledger.isDrawingStateDirty()).toBe(false);
  });

  it("keeps a queued snapshot dirty without advancing the epoch", () => {
    const ledger = createCanvasWriteLedger();
    ledger.markDrawingStateEdit();
    const epoch = ledger.drawingStateEpoch();
    ledger.markDrawingStateQueued();

    expect(ledger.drawingStateEpoch()).toBe(epoch);
    ledger.clearDrawingStateDirtyForEpoch(epoch);
    expect(ledger.isDrawingStateDirty()).toBe(false);
  });
});

describe("createCanvasWriteLedger geometry channel", () => {
  it("tracks dirty layers as a live view for reconciliation", () => {
    const ledger = createCanvasWriteLedger();
    const view = ledger.dirtyGeometryIds();

    ledger.markGeometryDirty("layer-1");
    expect(view.has("layer-1")).toBe(true);
    expect(ledger.dirtyGeometryCount()).toBe(1);

    ledger.clearGeometryDirty("layer-1");
    expect(view.has("layer-1")).toBe(false);
    expect(ledger.dirtyGeometryCount()).toBe(0);
  });

  it("notifies once per failure streak and re-arms after recovery", () => {
    const ledger = createCanvasWriteLedger();
    expect(ledger.recordGeometryFailure("layer-1")).toBe(true);
    // A second failing layer must not produce a second toast.
    expect(ledger.recordGeometryFailure("layer-2")).toBe(false);

    ledger.clearGeometryDirty("layer-1");
    ledger.clearGeometryDirty("layer-2");
    expect(ledger.recordGeometryFailure("layer-1")).toBe(true);
  });
});

describe("createCanvasWriteLedger retirement", () => {
  it("drops write claims and notifies the queue owner exactly once", () => {
    const ledger = createCanvasWriteLedger();
    const retired = vi.fn();
    const unsubscribe = ledger.onRetireLayers(retired);

    ledger.markGeometryDirty("layer-1");
    ledger.recordGeometryFailure("layer-1");
    ledger.retireLayers(["layer-1"]);

    expect(retired).toHaveBeenCalledTimes(1);
    expect(retired).toHaveBeenCalledWith(["layer-1"]);
    expect(ledger.dirtyGeometryCount()).toBe(0);
    // Failure bookkeeping is gone too, so the next real failure notifies.
    expect(ledger.recordGeometryFailure("layer-2")).toBe(true);

    unsubscribe();
    ledger.retireLayers(["layer-2"]);
    expect(retired).toHaveBeenCalledTimes(1);
  });

  it("ignores an empty retirement so nothing is torn down needlessly", () => {
    const ledger = createCanvasWriteLedger();
    const retired = vi.fn();
    ledger.onRetireLayers(retired);
    ledger.retireLayers([]);
    expect(retired).not.toHaveBeenCalled();
  });
});

describe("createCanvasWriteLedger pending create/delete bookkeeping", () => {
  it("moves a deleted layer out of pending-created and rolls back on failure", () => {
    const ledger = createCanvasWriteLedger();
    ledger.pendingCreatedIds().add("layer-1");

    ledger.markLayerDeleted("layer-1");
    expect(ledger.pendingCreatedIds().has("layer-1")).toBe(false);
    expect(ledger.pendingDeletedIds().has("layer-1")).toBe(true);

    ledger.rollbackLayerDeleted("layer-1");
    expect(ledger.pendingDeletedIds().has("layer-1")).toBe(false);
  });
});

describe("createCanvasWriteLedger save and unload reporting", () => {
  it("never reports saved while any channel is dirty or in flight", () => {
    const ledger = createCanvasWriteLedger();
    expect(ledger.canReportSaved()).toBe(true);

    ledger.beginWrite();
    expect(ledger.canReportSaved()).toBe(false);
    expect(ledger.isUnloadDirty(false)).toBe(true);
    ledger.endWrite();
    expect(ledger.canReportSaved()).toBe(true);

    ledger.markGeometryDirty("layer-1");
    expect(ledger.canReportSaved()).toBe(false);
    ledger.clearGeometryDirty("layer-1");

    ledger.markDrawingStateEdit();
    expect(ledger.canReportSaved()).toBe(false);
    ledger.clearDrawingStateDirtyForEpoch(ledger.drawingStateEpoch());
    expect(ledger.canReportSaved()).toBe(true);
  });

  it("clamps the in-flight count and treats pending locks as unload-dirty", () => {
    const ledger = createCanvasWriteLedger();
    ledger.endWrite();
    ledger.endWrite();
    expect(ledger.inFlightWrites()).toBe(0);

    expect(ledger.isUnloadDirty(false)).toBe(false);
    expect(ledger.isUnloadDirty(true)).toBe(true);
  });
});
