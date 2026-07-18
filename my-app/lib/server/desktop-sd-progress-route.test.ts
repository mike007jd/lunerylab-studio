import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireDesktopBridge: vi.fn(),
  proxyToBridge: vi.fn(),
}));

vi.mock("@/lib/server/desktop-bridge", () => ({
  requireDesktopBridge: mocks.requireDesktopBridge,
  proxyToBridge: mocks.proxyToBridge,
}));

import { GET } from "@/app/api/desktop-runtime/sd/progress/route";
import { POST } from "@/app/api/desktop-runtime/sd/cancel/route";

describe("desktop sd progress routes", () => {
  beforeEach(() => {
    mocks.requireDesktopBridge.mockReturnValue({ url: "http://127.0.0.1:49152", token: "token" });
    mocks.proxyToBridge.mockReset();
  });

  it("returns progress null without treating an unknown run as a polling error", async () => {
    mocks.proxyToBridge.mockResolvedValue(NextResponse.json({ progress: null }));

    const response = await GET(
      new NextRequest("http://localhost/api/desktop-runtime/sd/progress?runId=run-missing"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ progress: null });
    expect(mocks.proxyToBridge).toHaveBeenCalledWith(
      { url: "http://127.0.0.1:49152", token: "token" },
      "/sd-progress?runId=run-missing",
      undefined,
      expect.any(Function),
    );
  });

  it("rejects an invalid runId before touching the bridge", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/desktop-runtime/sd/progress?runId=bad%20id"),
    );

    expect(response.status).toBe(400);
    expect(mocks.proxyToBridge).not.toHaveBeenCalled();
  });

  it("forwards cancellation with the exact runId", async () => {
    mocks.proxyToBridge.mockResolvedValue(NextResponse.json({ canceled: true }));
    const response = await POST(
      new NextRequest("http://localhost/api/desktop-runtime/sd/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "run-1" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.proxyToBridge).toHaveBeenCalledWith(
      { url: "http://127.0.0.1:49152", token: "token" },
      "/sd-cancel",
      { method: "POST", body: JSON.stringify({ runId: "run-1" }) },
    );
  });
});
