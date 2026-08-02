import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  deleteByokConnectionMeta: vi.fn(),
  clearDefaultsOwnedByProvider: vi.fn(),
  requireLocalWorkspaceOwner: vi.fn(),
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
vi.mock("@/lib/server/clear-provider-defaults", () => ({
  clearDefaultsOwnedByProvider: mocks.clearDefaultsOwnedByProvider,
}));
vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));

import { DELETE } from "@/app/api/desktop-runtime/provider-connections/route";
import {
  getWorkspaceOperationGateStateForTests,
  resetWorkspaceOperationGateForTests,
  withSharedMutationLease,
} from "@/lib/server/workspace-operation-gate";

function deleteRequest(providerId = "openai") {
  return new NextRequest("http://localhost/api/desktop-runtime/provider-connections", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkspaceOperationGateForTests();
  mocks.isDesktopRuntime.mockReturnValue(true);
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
  mocks.clearDefaultsOwnedByProvider.mockResolvedValue({
    cleared: ["text", "image"],
    previous: {
      defaultTextModel: "byok:openai:gpt-4.1",
      defaultImageModel: "byok:openai:gpt-image-1",
      defaultVideoModel: "",
    },
  });
  mocks.requireDesktopBridge.mockReturnValue(
    NextResponse.json({ error: "bridge unavailable" }, { status: 503 }),
  );
});

describe("provider connection metadata removal", () => {
  it("clears owned defaults before unlinking metadata without requiring the native bridge", async () => {
    const order: string[] = [];
    mocks.clearDefaultsOwnedByProvider.mockImplementation(async () => {
      order.push("defaults");
      return { cleared: ["text"], previous: { defaultTextModel: "byok:openai:x", defaultImageModel: "", defaultVideoModel: "" } };
    });
    mocks.deleteByokConnectionMeta.mockImplementation(() => {
      order.push("metadata");
    });

    const response = await DELETE(deleteRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      clearedDefaults: ["text"],
    });
    expect(order).toEqual(["defaults", "metadata"]);
    expect(mocks.clearDefaultsOwnedByProvider).toHaveBeenCalledWith("user-1", "openai");
    expect(mocks.deleteByokConnectionMeta).toHaveBeenCalledWith("openai");
    expect(mocks.requireDesktopBridge).not.toHaveBeenCalled();
  });

  it("keeps metadata removal desktop-only", async () => {
    mocks.isDesktopRuntime.mockReturnValue(false);

    const response = await DELETE(deleteRequest());

    expect(response.status).toBe(404);
    expect(mocks.deleteByokConnectionMeta).not.toHaveBeenCalled();
    expect(mocks.clearDefaultsOwnedByProvider).not.toHaveBeenCalled();
  });

  it("drains an in-flight settings writer before clearing defaults and metadata", async () => {
    let releaseSettings!: () => void;
    let settingsStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      settingsStarted = resolve;
    });
    const settingsWrite = withSharedMutationLease(async () => {
      settingsStarted();
      await new Promise<void>((resolve) => {
        releaseSettings = resolve;
      });
    });
    await started;

    const unlink = DELETE(deleteRequest());
    await vi.waitFor(() => {
      expect(getWorkspaceOperationGateStateForTests().exclusivePending).toBe(true);
    });
    expect(mocks.clearDefaultsOwnedByProvider).not.toHaveBeenCalled();
    expect(mocks.deleteByokConnectionMeta).not.toHaveBeenCalled();

    releaseSettings();
    await settingsWrite;
    const response = await unlink;
    expect(response.status).toBe(200);
    expect(mocks.clearDefaultsOwnedByProvider).toHaveBeenCalledOnce();
    expect(mocks.deleteByokConnectionMeta).toHaveBeenCalledOnce();
  });
});
