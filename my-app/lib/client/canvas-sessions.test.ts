import { afterEach, describe, expect, it, vi } from "vitest";
import { patchCanvasLayer, sendAssetToCanvas } from "@/lib/client/canvas-sessions";

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
