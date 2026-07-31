import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  deleteByokConnectionMeta: vi.fn(),
  isDesktopRuntime: vi.fn(),
  requireDesktopBridge: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/desktop-runtime", () => ({
  isDesktopRuntime: mocks.isDesktopRuntime,
}));
vi.mock("@/lib/server/desktop-bridge", () => ({
  requireDesktopBridge: mocks.requireDesktopBridge,
}));
vi.mock("@/lib/server/byok-connection-store", () => ({
  deleteByokConnectionMeta: mocks.deleteByokConnectionMeta,
  getByokConnectionMeta: vi.fn(),
  listByokConnectionMeta: vi.fn(),
  setByokConnectionMeta: vi.fn(),
}));

import { DELETE } from "@/app/api/desktop-runtime/provider-connections/route";

function deleteRequest(providerId = "openai") {
  return new NextRequest("http://localhost/api/desktop-runtime/provider-connections", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isDesktopRuntime.mockReturnValue(true);
  mocks.requireDesktopBridge.mockReturnValue(
    NextResponse.json({ error: "bridge unavailable" }, { status: 503 }),
  );
});

describe("provider connection metadata removal", () => {
  it("removes profile metadata without requiring the native bridge", async () => {
    const response = await DELETE(deleteRequest());

    expect(response.status).toBe(200);
    expect(mocks.deleteByokConnectionMeta).toHaveBeenCalledWith("openai");
    expect(mocks.requireDesktopBridge).not.toHaveBeenCalled();
  });

  it("keeps metadata removal desktop-only", async () => {
    mocks.isDesktopRuntime.mockReturnValue(false);

    const response = await DELETE(deleteRequest());

    expect(response.status).toBe(404);
    expect(mocks.deleteByokConnectionMeta).not.toHaveBeenCalled();
  });
});
