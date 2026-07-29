import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CanvasLayerLockedError,
  patchCanvasLayer,
  sendAssetToCanvas,
  setCanvasLayerLocked,
} from "@/lib/client/canvas-sessions";

describe("patchCanvasLayer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps every bounded geometry write alive across navigation", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await patchCanvasLayer("session 1", "layer 1", { x: 12, y: 34 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/canvas/sessions/session%201/layers/layer%201",
      expect.objectContaining({ method: "PATCH", keepalive: true }),
    );
  });

  it("forwards cancellation to the geometry request", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await patchCanvasLayer("session 1", "layer 1", { x: 12 }, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/canvas/sessions/session%201/layers/layer%201",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("surfaces canvas_layer_locked as a non-retryable typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "canvas_layer_locked", message: "Unlock this layer before changing or deleting it." },
          { status: 409 },
        ),
      ),
    );

    await expect(patchCanvasLayer("session-1", "layer-1", { x: 1 })).rejects.toBeInstanceOf(
      CanvasLayerLockedError,
    );
  });
});

describe("setCanvasLayerLocked", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the explicit server lock contract for both directions", async () => {
    const fetchMock = vi.fn(async () => Response.json({ layer: { id: "layer 1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await setCanvasLayerLocked("session 1", "layer 1", true);
    await setCanvasLayerLocked("session 1", "layer 1", false);

    const [lockUrl, lockInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [unlockUrl, unlockInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(lockUrl).toBe("/api/canvas/sessions/session%201/layers/layer%201");
    expect(unlockUrl).toBe(lockUrl);
    expect(lockInit.method).toBe("PATCH");
    expect(JSON.parse(String(lockInit.body))).toEqual({ locked: true });
    expect(JSON.parse(String(unlockInit.body))).toEqual({ locked: false });
  });

  it("rejects a failed lock write so the caller can roll back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));

    await expect(setCanvasLayerLocked("session-1", "layer-1", true)).rejects.toThrow("status 500");
  });

  it("forwards an AbortSignal for bounded lock writes", async () => {
    const fetchMock = vi.fn(async () => Response.json({ layer: { id: "layer-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await setCanvasLayerLocked("session-1", "layer-1", true, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/canvas/sessions/session-1/layers/layer-1",
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("sendAssetToCanvas", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends only asset identity and lets the server own initial dimensions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({ session: { id: "session-1" }, url: "/canvas/session-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendAssetToCanvas({ assetId: "asset-1", projectId: "project-1", title: "Wide canvas" }),
    ).resolves.toEqual({ url: "/canvas/session-1" });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      projectId: "project-1",
      title: "Wide canvas",
      assetId: "asset-1",
    });
  });
});
