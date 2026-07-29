import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  access: vi.fn(),
  findHfModelEntry: vi.fn(),
  modelCachePath: vi.fn(),
  findImportedModel: vi.fn(),
  requireDesktopBridge: vi.fn(),
  proxyToBridge: vi.fn(),
}));

vi.mock("node:fs", () => ({
  constants: { R_OK: 4 },
  promises: {
    stat: mocks.stat,
    access: mocks.access,
  },
}));

vi.mock("@/lib/hf-model-catalog", () => ({
  findHfModelEntry: mocks.findHfModelEntry,
}));

vi.mock("@/lib/server/imported-model-registry", () => ({
  findImportedModel: mocks.findImportedModel,
  modelCachePath: mocks.modelCachePath,
}));

vi.mock("@/lib/server/desktop-bridge", () => ({
  requireDesktopBridge: mocks.requireDesktopBridge,
  proxyToBridge: mocks.proxyToBridge,
}));

import { POST } from "@/app/api/desktop-runtime/llama/route";

describe("/api/desktop-runtime/llama", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDesktopBridge.mockReturnValue({
      url: "http://127.0.0.1:49152",
      token: "bridge-token",
    });
    mocks.findHfModelEntry.mockReturnValue({
      id: "qwen-local",
      fileName: "qwen.gguf",
      capability: "planner-llm",
      runtimeTarget: "llama-cpp",
    });
    mocks.modelCachePath.mockReturnValue("/profile/models/llama-cpp/qwen.gguf");
    mocks.stat.mockResolvedValue({ isFile: () => true });
    mocks.access.mockResolvedValue(undefined);
    mocks.proxyToBridge.mockResolvedValue(Response.json({ running: true }));
  });

  it("passes the exact selected model id as the llama.cpp alias", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/desktop-runtime/llama", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId: "qwen-local" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.proxyToBridge).toHaveBeenCalledWith(
      expect.anything(),
      "/llama-start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          modelPath: "/profile/models/llama-cpp/qwen.gguf",
          modelId: "qwen-local",
        }),
      }),
    );
  });
});
