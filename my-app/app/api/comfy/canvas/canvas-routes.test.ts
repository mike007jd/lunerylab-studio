import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireDesktopBridge: vi.fn(),
  proxyToBridge: vi.fn(),
  validateComfyEndpoint: vi.fn(),
  getComfyConnection: vi.fn(),
  getActiveComfyConnection: vi.fn(),
}));

vi.mock("@/lib/server/desktop-bridge", () => ({
  requireDesktopBridge: mocks.requireDesktopBridge,
  proxyToBridge: mocks.proxyToBridge,
}));

vi.mock("@/lib/server/comfy-endpoint", () => ({
  validateComfyEndpoint: mocks.validateComfyEndpoint,
}));

vi.mock("@/lib/server/comfy-connection-store", () => ({
  getComfyConnection: mocks.getComfyConnection,
  getActiveComfyConnection: mocks.getActiveComfyConnection,
}));

vi.mock("@/lib/server/workspace-operation-gate", () => ({
  withSharedWorkspaceRead: (work: () => Promise<unknown>) => work(),
}));

vi.mock("@/lib/server/workspace-restore-journal", () => ({
  ensureWorkspaceRestoreReconciled: () => Promise.resolve(),
}));

import { POST as openPost } from "@/app/api/comfy/canvas/open/route";
import { POST as closePost } from "@/app/api/comfy/canvas/close/route";
import { POST as loadPost } from "@/app/api/comfy/canvas/load/route";

function request(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// A fresh reply per call: shared NextResponse instances carry internal state
// across matchers and break identity assertions.
function bridgeReply() {
  return NextResponse.json({ ok: true });
}

describe("/api/comfy/canvas/open", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDesktopBridge.mockReturnValue({ url: "http://127.0.0.1:49152", token: "t" });
    mocks.proxyToBridge.mockImplementation(() => bridgeReply());
    mocks.validateComfyEndpoint.mockImplementation(async (value: string) => ({ url: value }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the active connection through the bridge trust boundary", async () => {
    mocks.getActiveComfyConnection.mockReturnValue({
      id: "gmk",
      name: "gmk",
      endpoint: "http://100.120.182.80:8188",
    });

    const response = await openPost(request("/api/comfy/canvas/open", {}));

    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mocks.validateComfyEndpoint).toHaveBeenCalledWith("http://100.120.182.80:8188");
    expect(mocks.proxyToBridge).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://127.0.0.1:49152" }),
      "/comfy-canvas-open",
      {
        method: "POST",
        body: JSON.stringify({ endpoint: "http://100.120.182.80:8188" }),
      },
    );
  });

  it("opens an explicit connection id and forwards the reload flag", async () => {
    mocks.getComfyConnection.mockReturnValue({
      id: "lan",
      name: "lan",
      endpoint: "http://192.168.1.143:8188",
    });

    const response = await openPost(
      request("/api/comfy/canvas/open", { id: "lan", reload: true }),
    );

    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mocks.getActiveComfyConnection).not.toHaveBeenCalled();
    expect(mocks.proxyToBridge).toHaveBeenCalledWith(
      expect.anything(),
      "/comfy-canvas-open",
      {
        method: "POST",
        body: JSON.stringify({
          endpoint: "http://192.168.1.143:8188",
          reload: true,
        }),
      },
    );
  });

  it("404s when there is no connection to open", async () => {
    mocks.getActiveComfyConnection.mockReturnValue(undefined);

    const response = await openPost(request("/api/comfy/canvas/open", {}));

    expect(response.status).toBe(404);
    expect(mocks.proxyToBridge).not.toHaveBeenCalled();
  });

  it("rejects endpoints that fail validation before touching the bridge", async () => {
    mocks.getActiveComfyConnection.mockReturnValue({
      id: "bad",
      name: "bad",
      endpoint: "http://public.example:8188",
    });
    mocks.validateComfyEndpoint.mockResolvedValue({ error: "endpoint_not_allowed" });

    const response = await openPost(request("/api/comfy/canvas/open", {}));

    expect(response.status).toBe(400);
    expect(mocks.proxyToBridge).not.toHaveBeenCalled();
  });
});

describe("/api/comfy/canvas/close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDesktopBridge.mockReturnValue({ url: "http://127.0.0.1:49152", token: "t" });
    mocks.proxyToBridge.mockImplementation(() => bridgeReply());
  });

  it("proxies the close command to the bridge", async () => {
    const response = await closePost();

    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mocks.proxyToBridge).toHaveBeenCalledWith(
      expect.anything(),
      "/comfy-canvas-close",
      { method: "POST", body: "{}" },
    );
  });
});

describe("/api/comfy/canvas/load", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDesktopBridge.mockReturnValue({ url: "http://127.0.0.1:49152", token: "t" });
    mocks.proxyToBridge.mockImplementation(() => bridgeReply());
  });

  it("forwards an API-format workflow to the bridge", async () => {
    const workflow = { "3": { class_type: "KSampler", inputs: {} } };
    const response = await loadPost(request("/api/comfy/canvas/load", { workflow }));

    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mocks.proxyToBridge).toHaveBeenCalledWith(expect.anything(), "/comfy-canvas-load", {
      method: "POST",
      body: JSON.stringify({ workflow }),
      timeoutMs: 10_000,
    });
  });

  it("400s on a non-object workflow", async () => {
    const response = await loadPost(request("/api/comfy/canvas/load", { workflow: "nope" }));

    expect(response.status).toBe(400);
    expect(mocks.proxyToBridge).not.toHaveBeenCalled();
  });

  it("400s on unexpected extra fields", async () => {
    const response = await loadPost(
      request("/api/comfy/canvas/load", { workflow: {}, extra: true }),
    );

    expect(response.status).toBe(400);
    expect(mocks.proxyToBridge).not.toHaveBeenCalled();
  });
});
