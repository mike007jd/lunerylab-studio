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
import type { RawLayer } from "@/components/canvas/canvas-types";
import {
  createCanvasWriteLedger,
  type CanvasWriteLedger,
} from "@/components/canvas/canvas-write-ledger";
import {
  useCanvasAuthoritativeSync,
  type CanvasAuthoritativeSync,
} from "@/components/canvas/use-canvas-authoritative-sync";
import {
  useCanvasPersistenceCoordinator,
  type CanvasPersistenceCoordinator,
  type LayerDeletionPreparation,
} from "@/components/canvas/use-canvas-persistence-coordinator";
import type { LayerGeometryPatch } from "@/components/canvas/canvas-types";
import type { KonvaStageHandle } from "@/components/canvas/konva-stage";
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

function rawLayer(id: string, overrides: Partial<RawLayer> = {}): RawLayer {
  return {
    id,
    assetId: `asset-${id}`,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 1,
    ...overrides,
  };
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface SessionSnapshot {
  layers: RawLayer[];
  drawingState?: CanvasDrawingState;
  updatedAt?: string;
}

let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let ledger: CanvasWriteLedger;
let lockController: CanvasLayerLockController;
let sync: CanvasAuthoritativeSync;
let removedLayerIds: string[];
let session: SessionSnapshot;
let revision: string;
let deleteResponse: Response;
let deleteCalls: string[];
let sessionGetQueue: Array<() => Promise<Response>>;
let prepareLayerDeletion: ReturnType<
  typeof vi.fn<(layerId: string) => Promise<LayerDeletionPreparation>>
>;
let requeueDrainedGeometry: ReturnType<
  typeof vi.fn<(layerId: string, patch: LayerGeometryPatch) => void>
>;
let retiredLayerIds: string[][];

function sessionResponse(): Response {
  return jsonResponse(200, { session: { id: "sess-1", ...session } });
}

function Harness({
  pollWhenActive = false,
  pollIntervalMs = 8_000,
}: {
  pollWhenActive?: boolean;
  pollIntervalMs?: number;
}) {
  const api = useCanvasAuthoritativeSync({
    sessionId: "sess-1",
    ledger,
    lockController,
    copy,
    pollWhenActive,
    pollIntervalMs,
    onLayersRemoved: (layerIds) => {
      removedLayerIds.push(...layerIds);
    },
    prepareLayerDeletion,
    requeueDrainedGeometry,
  });
  // Publish the committed API for assertions; never during render.
  useEffect(() => {
    sync = api;
  }, [api]);
  return null;
}

async function mountSync(props: { pollWhenActive?: boolean; pollIntervalMs?: number } = {}) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(toast.error).mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  ledger = createCanvasWriteLedger();
  lockController = createCanvasLayerLockController();
  removedLayerIds = [];
  session = { layers: [rawLayer("l1"), rawLayer("l2")], updatedAt: "1" };
  revision = "r1";
  deleteResponse = jsonResponse(200, {});
  deleteCalls = [];
  sessionGetQueue = [];
  prepareLayerDeletion = vi.fn<(layerId: string) => Promise<LayerDeletionPreparation>>(
    async () => ({ ok: true, drainedGeometry: null, release() {} }),
  );
  requeueDrainedGeometry = vi.fn<(layerId: string, patch: LayerGeometryPatch) => void>();
  retiredLayerIds = [];
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "DELETE") {
      deleteCalls.push(url);
      return Promise.resolve(deleteResponse);
    }
    if (url.endsWith("/revision")) {
      return Promise.resolve(jsonResponse(200, { revision }));
    }
    const queued = sessionGetQueue.shift();
    return queued ? queued() : Promise.resolve(sessionResponse());
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("canvas authoritative sync initial load", () => {
  it("publishes mapped layers and the persisted annotation snapshot", async () => {
    session = { layers: [rawLayer("l1", { x: 5 })], drawingState: drawingState("note") };
    await mountSync();

    expect(sync.loading).toBe(false);
    expect(sync.error).toBeNull();
    expect(sync.layers).toEqual([
      {
        id: "l1",
        assetId: "asset-l1",
        assetUrl: "/api/assets/asset-l1",
        x: 5,
        y: 0,
        width: 100,
        height: 100,
        rotation: undefined,
        zIndex: 1,
        hidden: undefined,
        locked: undefined,
      },
    ]);
    expect(sync.drawingState).toEqual(drawingState("note"));
  });

  it("surfaces a load failure with a retry that re-fetches", async () => {
    sessionGetQueue.push(() => Promise.reject(new Error("offline")));
    await mountSync();
    expect(sync.error).toBe("offline");

    await act(async () => {
      sync.retry();
    });
    expect(sync.error).toBeNull();
    expect(sync.layers).toHaveLength(2);
  });
});

describe("canvas authoritative sync response ordering", () => {
  it("never lets a delayed older resync response overwrite a newer one", async () => {
    await mountSync();

    const stale = deferred<Response>();
    sessionGetQueue.push(() => stale.promise);
    session = { layers: [rawLayer("l1", { x: 111 })], updatedAt: "2" };

    await act(async () => {
      sync.resyncLayers();
    });
    // Nothing applied yet: the first recovery response is still in flight.
    expect(sync.layers[0]?.x).toBe(0);

    // A newer recovery starts and lands first.
    session = { layers: [rawLayer("l1", { x: 222 })], updatedAt: "3" };
    await act(async () => {
      sync.resyncLayers();
    });
    expect(sync.layers[0]?.x).toBe(222);

    // The stale response arrives last and must be dropped.
    await act(async () => {
      stale.resolve(jsonResponse(200, { session: { id: "sess-1", layers: [rawLayer("l1", { x: 111 })] } }));
    });
    expect(sync.layers[0]?.x).toBe(222);
  });

  it("keeps unsaved annotations while still applying polled layer geometry", async () => {
    vi.useFakeTimers();
    session = {
      layers: [rawLayer("l1", { x: 1 })],
      drawingState: drawingState("local"),
      updatedAt: "1",
    };
    await mountSync({ pollWhenActive: true, pollIntervalMs: 1_000 });
    expect(sync.drawingState).toEqual(drawingState("local"));

    // The user is mid-annotation: the inbound snapshot must not replace it.
    ledger.markDrawingStateEdit();
    revision = "r2";
    session = {
      layers: [rawLayer("l1", { x: 42 })],
      drawingState: drawingState("server"),
      updatedAt: "2",
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(sync.layers[0]?.x).toBe(42);
    expect(sync.drawingState).toEqual(drawingState("local"));

    // Once the newest local edit is persisted, polling syncs normally again.
    ledger.clearDrawingStateDirtyForEpoch(ledger.drawingStateEpoch());
    revision = "r3";
    session = {
      layers: [rawLayer("l1", { x: 43 })],
      drawingState: drawingState("server"),
      updatedAt: "3",
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(sync.drawingState).toEqual(drawingState("server"));
  });
});

describe("canvas authoritative sync layer deletion", () => {
  it("removes the layer optimistically and restores drained geometry on failure", async () => {
    const release = vi.fn();
    prepareLayerDeletion.mockResolvedValue({
      ok: true,
      drainedGeometry: { x: 77 },
      release,
    });
    await mountSync();
    deleteResponse = jsonResponse(500, {});
    // Stale server snapshot — drained geometry must still win after resync.
    session = { layers: [rawLayer("l1", { x: 0 }), rawLayer("l2")], updatedAt: "2" };

    await act(async () => {
      sync.deleteLayer("l1");
    });

    expect(deleteCalls).toEqual(["/api/canvas/sessions/sess-1/layers/l1"]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(copy.toastDeleteLayerFailed);
    // The rollback drops the delete claim so the resync can bring the layer back.
    expect(ledger.pendingDeletedIds().has("l1")).toBe(false);
    expect(removedLayerIds).toEqual(["l1"]);
    expect(sync.layers.map((layer) => layer.id)).toEqual(["l1", "l2"]);
    expect(sync.layers.find((layer) => layer.id === "l1")?.x).toBe(77);
    expect(requeueDrainedGeometry).toHaveBeenCalledWith("l1", { x: 77 });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not send DELETE when geometry drain fails and keeps retirement idle", async () => {
    const release = vi.fn();
    prepareLayerDeletion.mockResolvedValue({
      ok: false,
      drainedGeometry: { x: 77 },
      release,
    });
    await mountSync();
    const retireSpy = vi.fn((ids: readonly string[]) => {
      retiredLayerIds.push([...ids]);
    });
    ledger.onRetireLayers(retireSpy);

    await act(async () => {
      sync.deleteLayer("l1");
    });

    expect(deleteCalls).toEqual([]);
    expect(retireSpy).not.toHaveBeenCalled();
    expect(sync.layers.map((layer) => layer.id)).toEqual(["l1", "l2"]);
    expect(ledger.pendingDeletedIds().has("l1")).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps the local layer and drained geometry when DELETE and recovery GET both fail", async () => {
    const release = vi.fn();
    prepareLayerDeletion.mockResolvedValue({
      ok: true,
      drainedGeometry: { x: 77 },
      release,
    });
    await mountSync();
    deleteResponse = jsonResponse(500, {});
    sessionGetQueue.push(() => Promise.reject(new Error("still offline")));
    const retireSpy = vi.fn();
    ledger.onRetireLayers(retireSpy);

    await act(async () => {
      sync.deleteLayer("l1");
    });

    expect(sync.layers.find((layer) => layer.id === "l1")?.x).toBe(77);
    expect(retireSpy).not.toHaveBeenCalled();
    expect(requeueDrainedGeometry).toHaveBeenCalledWith("l1", { x: 77 });
    expect(release).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(copy.toastDeleteLayerFailed);
  });

  it("retires persistence only after DELETE succeeds", async () => {
    await mountSync();
    const retireSpy = vi.fn((ids: readonly string[]) => {
      retiredLayerIds.push([...ids]);
    });
    ledger.onRetireLayers(retireSpy);

    await act(async () => {
      sync.deleteLayer("l1");
    });

    expect(deleteCalls).toEqual(["/api/canvas/sessions/sess-1/layers/l1"]);
    expect(retireSpy).toHaveBeenCalledWith(["l1"]);
    expect(sync.layers.map((layer) => layer.id)).toEqual(["l2"]);
  });

  it("confirms server truth instead of trusting a 404 and retires when absent", async () => {
    await mountSync();
    deleteResponse = jsonResponse(404, {});
    session = { layers: [rawLayer("l2")], updatedAt: "2" };
    const retireSpy = vi.fn((ids: readonly string[]) => {
      retiredLayerIds.push([...ids]);
    });
    ledger.onRetireLayers(retireSpy);

    await act(async () => {
      sync.deleteLayer("l1");
    });

    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(ledger.pendingDeletedIds().has("l1")).toBe(false);
    expect(sync.layers.map((layer) => layer.id)).toEqual(["l2"]);
    expect(retireSpy).toHaveBeenCalledWith(["l1"]);
  });

  it("refuses to delete a locked layer", async () => {
    session = { layers: [rawLayer("l1", { locked: true })], updatedAt: "1" };
    await mountSync();

    await act(async () => {
      sync.deleteLayer("l1");
    });

    expect(deleteCalls).toEqual([]);
    expect(sync.layers.map((layer) => layer.id)).toEqual(["l1"]);
  });
});

describe("canvas delete cross-owner integrity", () => {
  it("drains pending x=77 before DELETE, restores it after failed DELETE + resync", async () => {
    let crossSync!: CanvasAuthoritativeSync;
    let crossPersistence!: CanvasPersistenceCoordinator;
    const persistenceApiRef: {
      current: {
        prepareLayerDeletion: CanvasPersistenceCoordinator["prepareLayerDeletion"];
        patchLayerGeometry: CanvasPersistenceCoordinator["patchLayerGeometry"];
      } | null;
    } = { current: null };

    function CrossHarness() {
      const syncApi = useCanvasAuthoritativeSync({
        sessionId: "sess-1",
        ledger,
        lockController,
        copy,
        pollWhenActive: false,
        pollIntervalMs: 8_000,
        onLayersRemoved: (layerIds) => {
          removedLayerIds.push(...layerIds);
        },
        prepareLayerDeletion: (layerId) =>
          persistenceApiRef.current?.prepareLayerDeletion(layerId) ??
          Promise.resolve({ ok: false, drainedGeometry: null, release() {} }),
        requeueDrainedGeometry: (layerId, patch) => {
          void persistenceApiRef.current?.patchLayerGeometry(layerId, patch);
        },
      });
      const persistenceApi = useCanvasPersistenceCoordinator({
        sessionId: "sess-1",
        ledger,
        lockController,
        stageRef: { current: { flushDrawingState: () => undefined } as KonvaStageHandle },
        copy,
        isLayerLocked: syncApi.isLayerLocked,
        applyLocalDrawingState: syncApi.applyLocalDrawingState,
        requestAuthoritativeResync: syncApi.resyncLayers,
      });
      useEffect(() => {
        const bridge = {
          prepareLayerDeletion: persistenceApi.prepareLayerDeletion,
          patchLayerGeometry: persistenceApi.patchLayerGeometry,
        };
        persistenceApiRef.current = bridge;
        crossSync = syncApi;
        crossPersistence = persistenceApi;
        return () => {
          if (persistenceApiRef.current === bridge) persistenceApiRef.current = null;
        };
      }, [syncApi, persistenceApi]);
      return null;
    }

    vi.useFakeTimers();
    const requestOrder: string[] = [];
    let resolvePatch!: (response: Response) => void;
    const patchGate = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PATCH" && url.includes("/layers/")) {
        requestOrder.push("PATCH");
        const body = JSON.parse(String(init?.body ?? "{}")) as { x?: number };
        session = {
          layers: [
            rawLayer("l1", { x: body.x ?? 0 }),
            rawLayer("l2"),
          ],
          updatedAt: "2",
        };
        return patchGate;
      }
      if (method === "DELETE") {
        requestOrder.push("DELETE");
        return Promise.resolve(jsonResponse(500, {}));
      }
      requestOrder.push("GET");
      return Promise.resolve(sessionResponse());
    });

    await act(async () => {
      root.render(<CrossHarness />);
    });

    await act(async () => {
      await crossPersistence.patchLayerGeometry("l1", { x: 77 });
    });

    let deleteStarted = false;
    await act(async () => {
      crossSync.deleteLayer("l1");
      deleteStarted = true;
    });
    expect(deleteStarted).toBe(true);
    // Barrier is held during drain — new transforms must not race preflight.
    expect(crossPersistence.isDeletionBlocked("l1")).toBe(true);
    expect(requestOrder).toContain("PATCH");
    expect(requestOrder).not.toContain("DELETE");

    await act(async () => {
      resolvePatch(jsonResponse(200, {}));
      await patchGate;
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(requestOrder.filter((entry) => entry === "PATCH").length).toBeGreaterThanOrEqual(1);
    expect(requestOrder).toContain("DELETE");
    const patchIndex = requestOrder.indexOf("PATCH");
    const deleteIndex = requestOrder.indexOf("DELETE");
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(patchIndex);

    await vi.waitFor(() => {
      expect(crossSync.layers.find((layer) => layer.id === "l1")?.x).toBe(77);
    });
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(copy.toastDeleteLayerFailed);
    expect(crossPersistence.isDeletionBlocked("l1")).toBe(false);
  });
});

describe("canvas authoritative sync queue retirement", () => {
  it("retires local writes for a layer the server proves is gone", async () => {
    await mountSync();
    const retired = vi.fn();
    ledger.onRetireLayers(retired);
    ledger.markGeometryDirty("l2");

    session = { layers: [rawLayer("l1")], updatedAt: "2" };
    await act(async () => {
      sync.resyncLayers();
    });

    expect(retired).toHaveBeenCalledWith(["l2"]);
    expect(ledger.dirtyGeometryCount()).toBe(0);
    expect(removedLayerIds).toEqual(["l2"]);
    expect(sync.layers.map((layer) => layer.id)).toEqual(["l1"]);
  });

  it("keeps a locally dirty layer that the server still has", async () => {
    await mountSync();
    ledger.markGeometryDirty("l2");
    // Local drag position must survive the merge; server fields must not.
    await act(async () => {
      sync.setLayerLockedLocally("l2", false);
    });

    session = { layers: [rawLayer("l1"), rawLayer("l2", { x: 999, locked: true })], updatedAt: "2" };
    await act(async () => {
      sync.resyncLayers();
    });

    const merged = sync.layers.find((layer) => layer.id === "l2");
    expect(merged?.x).toBe(0);
    expect(merged?.locked).toBe(true);
    expect(ledger.dirtyGeometryIds().has("l2")).toBe(true);
  });
});
