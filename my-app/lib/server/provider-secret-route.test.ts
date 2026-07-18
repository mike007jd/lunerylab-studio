import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  bumpDesktopStatusRevision: vi.fn(),
  proxyToBridge: vi.fn(),
  requireDesktopBridge: vi.fn(),
}));

vi.mock("@/lib/server/desktop-status-revision", () => ({
  bumpDesktopStatusRevision: mocks.bumpDesktopStatusRevision,
}));
vi.mock("@/lib/server/desktop-bridge", () => ({
  proxyToBridge: mocks.proxyToBridge,
  requireDesktopBridge: mocks.requireDesktopBridge,
}));

import { POST } from "@/app/api/desktop-runtime/provider-secret/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireDesktopBridge.mockReturnValue({
    url: "http://127.0.0.1:49100",
    token: "token",
  });
});

describe("provider secret cache invalidation", () => {
  it("bumps the cross-bundle revision before and after a successful mutation", async () => {
    mocks.proxyToBridge.mockResolvedValue(NextResponse.json({ ok: true }));
    const response = await POST(
      new NextRequest("http://localhost/api/desktop-runtime/provider-secret", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai", apiKey: "secret" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.bumpDesktopStatusRevision).toHaveBeenCalledTimes(2);
  });

  it("keeps the pre-mutation invalidation when the bridge rejects the write", async () => {
    mocks.proxyToBridge.mockResolvedValue(
      NextResponse.json({ error: "invalid provider" }, { status: 400 }),
    );
    const response = await POST(
      new NextRequest("http://localhost/api/desktop-runtime/provider-secret", {
        method: "POST",
        body: JSON.stringify({ providerId: "unknown", apiKey: "secret" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.bumpDesktopStatusRevision).toHaveBeenCalledOnce();
  });
});
