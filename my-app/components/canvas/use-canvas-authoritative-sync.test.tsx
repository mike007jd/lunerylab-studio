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
  it("removes the layer optimistically and restores it from storage on failure", async () => {
    await mountSync();
    deleteResponse = jsonResponse(500, {});

    await act(async () => {
      sync.deleteLayer("l1");
    });

    expect(deleteCalls).toEqual(["/api/canvas/sessions/sess-1/layers/l1"]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(copy.toastDeleteLayerFailed);
    // The rollback drops the delete claim so the resync can bring the layer back.
    expect(ledger.pendingDeletedIds().has("l1")).toBe(false);
    expect(removedLayerIds).toEqual(["l1"]);
    expect(sync.layers.map((layer) => layer.id)).toEqual(["l1", "l2"]);
  });

  it("confirms server truth instead of trusting a 404", async () => {
    await mountSync();
    deleteResponse = jsonResponse(404, {});
    session = { layers: [rawLayer("l2")], updatedAt: "2" };

    await act(async () => {
      sync.deleteLayer("l1");
    });

    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(ledger.pendingDeletedIds().has("l1")).toBe(false);
    expect(sync.layers.map((layer) => layer.id)).toEqual(["l2"]);
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
