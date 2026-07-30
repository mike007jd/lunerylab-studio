// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { COPY } from "@/components/canvas/canvas-copy";
import {
  createCanvasLayerLockController,
  type CanvasLayerLockController,
} from "@/components/canvas/canvas-layer-lock";
import { PATCH_DEBOUNCE_MS } from "@/components/canvas/canvas-types";
import {
  createCanvasWriteLedger,
  type CanvasWriteLedger,
} from "@/components/canvas/canvas-write-ledger";
import type { KonvaStageHandle } from "@/components/canvas/konva-stage";
import {
  useCanvasPersistenceCoordinator,
  type CanvasPersistenceCoordinator,
} from "@/components/canvas/use-canvas-persistence-coordinator";
import type { CanvasDrawingState } from "@/lib/canvas/drawing-state";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const copy = COPY.en;

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => payload,
  } as unknown as Response;
}

function drawingState(text: string): CanvasDrawingState {
  return {
    version: 1,
    freehandLines: [],
    textNodes: [
      {
        id: "t1",
        x: 0,
        y: 0,
        text,
        fontSize: 16,
        fontFamily: "sans-serif",
        fill: "#fff",
        align: "left",
      },
    ],
    shapes: [],
  };
}

let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let ledger: CanvasWriteLedger;
let lockController: CanvasLayerLockController;
let flushDrawingState: ReturnType<typeof vi.fn<() => void>>;
let requestAuthoritativeResync: ReturnType<typeof vi.fn<() => void>>;
let lockedLayerIds: Set<string>;
let localDrawingStates: CanvasDrawingState[];
let coordinator: CanvasPersistenceCoordinator;

function Harness({ sessionId = "sess-1" }: { sessionId?: string }) {
  const api = useCanvasPersistenceCoordinator({
    sessionId,
    ledger,
    lockController,
    stageRef: { current: { flushDrawingState } as unknown as KonvaStageHandle },
    copy,
    isLayerLocked: (layerId) => lockedLayerIds.has(layerId),
    applyLocalDrawingState: (state) => {
      localDrawingStates.push(state);
    },
    requestAuthoritativeResync,
  });
  // Publish the committed API for assertions; never during render.
  useEffect(() => {
    coordinator = api;
  }, [api]);
  return null;
}

async function mountCoordinator() {
  await act(async () => {
    root.render(<Harness />);
  });
}

function patchRequests(): Array<{ url: string; body: unknown }> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
    .map(([input, init]) => ({
      url: String(input),
      body: JSON.parse(String((init as RequestInit).body)),
    }));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.mocked(toast.error).mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, {})));
  vi.stubGlobal("fetch", fetchMock);
  ledger = createCanvasWriteLedger();
  lockController = createCanvasLayerLockController();
  flushDrawingState = vi.fn<() => void>();
  requestAuthoritativeResync = vi.fn<() => void>();
  lockedLayerIds = new Set<string>();
  localDrawingStates = [];
});

afterEach(async () => {
  // Unmount inside act so the deferred writer disposal (a microtask) still
  // sees the mocked fetch instead of leaking a real request into teardown.
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("canvas persistence coordinator delete preflight", () => {
  it("installs a synchronous barrier, drains pending geometry, and releases once", async () => {
    let resolvePatch!: (response: Response) => void;
    const patchGate = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    fetchMock.mockImplementation(() => patchGate);
    await mountCoordinator();

    await act(async () => {
      await coordinator.patchLayerGeometry("layer-1", { x: 77 });
    });

    let preparation!: Awaited<ReturnType<typeof coordinator.prepareLayerDeletion>>;
    let prepareDone = false;
    await act(async () => {
      const pending = coordinator.prepareLayerDeletion("layer-1");
      // Barrier is synchronous — held before the first await yields.
      expect(coordinator.isDeletionBlocked("layer-1")).toBe(true);
      // New transforms cannot race the drain/delete preflight.
      await coordinator.patchLayerGeometry("layer-1", { x: 99 });
      resolvePatch(jsonResponse(200, {}));
      preparation = await pending;
      prepareDone = true;
    });

    expect(prepareDone).toBe(true);
    expect(preparation.ok).toBe(true);
    expect(preparation.drainedGeometry).toEqual({ x: 77 });
    // The caller owns the barrier through DELETE/recovery.
    expect(coordinator.isDeletionBlocked("layer-1")).toBe(true);
    preparation.release();
    preparation.release();
    expect(coordinator.isDeletionBlocked("layer-1")).toBe(false);
    expect(patchRequests()).toEqual([
      { url: "/api/canvas/sessions/sess-1/layers/layer-1", body: { x: 77 } },
    ]);
    // The racing x=99 was rejected while the barrier was held.
    expect(patchRequests()).toHaveLength(1);
  });

  it("returns ok=false when drain fails and leaves the queue recoverable", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(500, {})));
    await mountCoordinator();

    await act(async () => {
      await coordinator.patchLayerGeometry("layer-1", { x: 77 });
    });

    let preparation!: Awaited<ReturnType<typeof coordinator.prepareLayerDeletion>>;
    await act(async () => {
      const pending = coordinator.prepareLayerDeletion("layer-1");
      await vi.advanceTimersByTimeAsync(10_000);
      preparation = await pending;
    });

    expect(preparation.ok).toBe(false);
    expect(preparation.drainedGeometry).toEqual({ x: 77 });
    expect(coordinator.isDeletionBlocked("layer-1")).toBe(true);
    preparation.release();
    expect(coordinator.isDeletionBlocked("layer-1")).toBe(false);
    // Queue remains dirty/recoverable — a later flush can still persist.
    expect(ledger.dirtyGeometryIds().has("layer-1")).toBe(true);

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, {})));
    let recovered: boolean | undefined;
    await act(async () => {
      await coordinator.patchLayerGeometry("layer-1", { x: 88 });
      recovered = await coordinator.flushPendingGeometry("layer-1");
    });
    expect(recovered).toBe(true);
    expect(patchRequests().at(-1)).toEqual({
      url: "/api/canvas/sessions/sess-1/layers/layer-1",
      body: { x: 88 },
    });
  });
});

describe("canvas persistence coordinator geometry writes", () => {
  it("coalesces a drag burst into one PATCH and only then reports saved", async () => {
    await mountCoordinator();

    await act(async () => {
      await coordinator.patchLayerGeometry("layer-1", { x: 10 });
      await coordinator.patchLayerGeometry("layer-1", { y: 20 });
    });

    // Dirty and "saving" before anything reaches the network.
    expect(ledger.dirtyGeometryIds().has("layer-1")).toBe(true);
    expect(coordinator.saveStatus).toBe("saving");
    expect(patchRequests()).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PATCH_DEBOUNCE_MS);
    });

    expect(patchRequests()).toEqual([
      { url: "/api/canvas/sessions/sess-1/layers/layer-1", body: { x: 10, y: 20 } },
    ]);
    expect(ledger.dirtyGeometryCount()).toBe(0);
    expect(coordinator.saveStatus).toBe("saved");

    // The badge is transient; geometry stays clean afterwards.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(coordinator.saveStatus).toBe("idle");
  });

  it("rejects geometry for a locked layer and while a lock transition holds the barrier", async () => {
    await mountCoordinator();
    lockedLayerIds.add("layer-locked");

    await act(async () => {
      await coordinator.patchLayerGeometry("layer-locked", { x: 5 });
      await vi.advanceTimersByTimeAsync(PATCH_DEBOUNCE_MS);
    });

    expect(patchRequests()).toHaveLength(0);
    expect(ledger.dirtyGeometryCount()).toBe(0);
  });

  it("flushes one layer's debounced geometry on demand for the lock contract", async () => {
    await mountCoordinator();

    let flushed: boolean | undefined;
    await act(async () => {
      await coordinator.patchLayerGeometry("layer-1", { x: 7 });
      flushed = await coordinator.flushPendingGeometry("layer-1");
    });

    // Resolved true only after the newest patch actually reached storage —
    // this is what lets the lock controller persist a lock safely.
    expect(flushed).toBe(true);
    expect(patchRequests()).toEqual([
      { url: "/api/canvas/sessions/sess-1/layers/layer-1", body: { x: 7 } },
    ]);
    expect(ledger.dirtyGeometryCount()).toBe(0);
  });
});

describe("canvas persistence coordinator non-retryable geometry failure", () => {
  it("drops the patch, warns once, and asks the authoritative owner to resync", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(409, { code: "canvas_layer_locked" })),
    );
    await mountCoordinator();

    await act(async () => {
      await coordinator.patchLayerGeometry("layer-1", { x: 10 });
      await vi.advanceTimersByTimeAsync(PATCH_DEBOUNCE_MS);
    });

    expect(patchRequests()).toHaveLength(1);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(copy.toastLockLayerFailed);
    expect(requestAuthoritativeResync).toHaveBeenCalledTimes(1);
    // Coalesced geometry against a locked layer can never land: it is dropped,
    // not retried, and the layer stops claiming local ownership — so window
    // teardown is no longer blocked on a write that will never succeed.
    expect(ledger.dirtyGeometryCount()).toBe(0);
    expect(ledger.isUnloadDirty(false)).toBe(false);
    expect(coordinator.saveStatus).toBe("idle");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(patchRequests()).toHaveLength(1);

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, {})));
    await act(async () => {
      await coordinator.patchLayerGeometry("layer-1", { x: 20 });
      await vi.advanceTimersByTimeAsync(PATCH_DEBOUNCE_MS);
    });
    expect(patchRequests()).toHaveLength(2);
    expect(ledger.dirtyGeometryCount()).toBe(0);
    expect(coordinator.saveStatus).toBe("saved");
  });
});

describe("canvas persistence coordinator retirement", () => {
  it("cancels a pending write when the authoritative owner retires the layer", async () => {
    await mountCoordinator();

    await act(async () => {
      await coordinator.patchLayerGeometry("layer-1", { x: 10 });
    });
    act(() => {
      ledger.retireLayers(["layer-1"]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PATCH_DEBOUNCE_MS * 4);
    });

    expect(patchRequests()).toHaveLength(0);
    expect(ledger.dirtyGeometryCount()).toBe(0);

    // The retired layer's writer was torn down, not merely closed: a layer that
    // comes back (undo / agent re-create) must still persist.
    await act(async () => {
      await coordinator.patchLayerGeometry("layer-1", { x: 30 });
      await vi.advanceTimersByTimeAsync(PATCH_DEBOUNCE_MS);
    });
    expect(patchRequests()).toEqual([
      { url: "/api/canvas/sessions/sess-1/layers/layer-1", body: { x: 30 } },
    ]);
  });

  it("balances an active write when authoritative retirement races its response", async () => {
    let resolvePatch!: (response: Response) => void;
    const patchResponse = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    fetchMock.mockImplementation(() => patchResponse);
    await mountCoordinator();

    await act(async () => {
      await coordinator.patchLayerGeometry("layer-1", { x: 10 });
      await vi.advanceTimersByTimeAsync(PATCH_DEBOUNCE_MS);
    });
    expect(ledger.inFlightWrites()).toBe(1);

    act(() => {
      ledger.retireLayers(["layer-1"]);
    });
    await act(async () => {
      resolvePatch(jsonResponse(200, {}));
      await patchResponse;
    });

    expect(ledger.inFlightWrites()).toBe(0);
    expect(ledger.dirtyGeometryCount()).toBe(0);
    expect(ledger.isUnloadDirty(false)).toBe(false);
    expect(coordinator.saveStatus).toBe("idle");

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, {})));
    await act(async () => {
      await coordinator.patchLayerGeometry("layer-1", { x: 30 });
      await vi.advanceTimersByTimeAsync(PATCH_DEBOUNCE_MS);
    });
    expect(patchRequests()).toHaveLength(2);
  });
});

describe("canvas persistence coordinator exit contract", () => {
  it("drains the stage, geometry debounce, and drawing-state writer before navigating", async () => {
    await mountCoordinator();

    await act(async () => {
      coordinator.handleDrawingStateDirty();
      coordinator.handleDrawingStateChange(drawingState("note"));
      await coordinator.patchLayerGeometry("layer-1", { x: 12 });
    });
    expect(localDrawingStates).toHaveLength(1);

    let drained: boolean | undefined;
    await act(async () => {
      drained = await coordinator.flushForExit();
    });

    expect(flushDrawingState).toHaveBeenCalledTimes(1);
    expect(drained).toBe(true);
    expect(patchRequests()).toEqual(
      expect.arrayContaining([
        { url: "/api/canvas/sessions/sess-1", body: { drawingState: drawingState("note") } },
        { url: "/api/canvas/sessions/sess-1/layers/layer-1", body: { x: 12 } },
      ]),
    );
    expect(ledger.isUnloadDirty(false)).toBe(false);
    // The button stays busy through navigation; a second press cannot re-enter.
    expect(coordinator.exitPending).toBe(true);
    let second: boolean | undefined;
    await act(async () => {
      second = await coordinator.flushForExit();
    });
    expect(second).toBe(false);
  });

  it("keeps the user on the canvas and warns when a channel never persists", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(500, {})));
    await mountCoordinator();

    await act(async () => {
      coordinator.handleDrawingStateDirty();
      coordinator.handleDrawingStateChange(drawingState("unsaved"));
    });

    let drained: boolean | undefined;
    await act(async () => {
      const pending = coordinator.flushForExit();
      // Bounded retries must all settle before the exit decision is made.
      await vi.advanceTimersByTimeAsync(10_000);
      drained = await pending;
    });

    expect(drained).toBe(false);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(copy.toastSaveFailed);
    expect(ledger.isDrawingStateDirty()).toBe(true);
    expect(coordinator.exitPending).toBe(false);
  });
});

describe("canvas persistence coordinator unload guard", () => {
  it("blocks window teardown while a write is unsaved and releases it after", async () => {
    await mountCoordinator();

    await act(async () => {
      await coordinator.patchLayerGeometry("layer-1", { x: 3 });
    });
    const blocked = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PATCH_DEBOUNCE_MS);
    });
    const allowed = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(allowed);
    expect(allowed.defaultPrevented).toBe(false);
  });
});
