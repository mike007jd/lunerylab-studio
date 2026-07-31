import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { DESKTOP_WORKSPACE_RESET_CONFIRMATION } from "@/lib/desktop-workspace-reset";

const mocks = vi.hoisted(() => ({
  proxyToBridge: vi.fn(),
  requireDesktopBridge: vi.fn(),
}));

vi.mock("@/lib/server/desktop-bridge", () => ({
  proxyToBridge: mocks.proxyToBridge,
  requireDesktopBridge: mocks.requireDesktopBridge,
}));

import { POST } from "@/app/api/desktop-runtime/reset-workspace/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireDesktopBridge.mockReturnValue({
    url: "http://127.0.0.1:49100",
    token: "token",
  });
});
function request(confirmation: string) {
  return new NextRequest("http://localhost/api/desktop-runtime/reset-workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation }),
  });
}

describe("desktop workspace reset route", () => {
  it("requires the explicit destructive confirmation before reaching the bridge", async () => {
    const response = await POST(request("yes"));

    expect(response.status).toBe(400);
    expect(mocks.requireDesktopBridge).not.toHaveBeenCalled();
    expect(mocks.proxyToBridge).not.toHaveBeenCalled();
  });

  it("forwards a confirmed reset to the authenticated desktop bridge", async () => {
    mocks.proxyToBridge.mockResolvedValue(
      NextResponse.json({ resetting: true }, { status: 202 }),
    );

    const response = await POST(request(DESKTOP_WORKSPACE_RESET_CONFIRMATION));

    expect(response.status).toBe(202);
    expect(mocks.proxyToBridge).toHaveBeenCalledWith(
      { url: "http://127.0.0.1:49100", token: "token" },
      "/reset-workspace",
      {
        method: "POST",
        body: JSON.stringify({
          confirmation: DESKTOP_WORKSPACE_RESET_CONFIRMATION,
        }),
      },
    );
  });
});
