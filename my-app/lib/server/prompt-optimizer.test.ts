import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateTextLocal: vi.fn(),
  generateTextByok: vi.fn(),
  resolveTextRuntimeSupply: vi.fn(),
  resolveRuntimeByokCandidates: vi.fn(),
}));

vi.mock("@/lib/server/local-llm", () => ({
  generateTextLocal: mocks.generateTextLocal,
}));

vi.mock("@/lib/server/byok-llm", () => ({
  generateTextByok: mocks.generateTextByok,
}));

vi.mock("@/lib/server/runtime-supply", () => ({
  resolveTextRuntimeSupply: mocks.resolveTextRuntimeSupply,
  resolveRuntimeByokCandidates: mocks.resolveRuntimeByokCandidates,
}));

import { optimizePrompt } from "@/lib/server/prompt-optimizer";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTextRuntimeSupply.mockResolvedValue({
    backend: "local",
    endpoint: "http://localhost:11434",
    modelId: "llama",
  });
  mocks.resolveRuntimeByokCandidates.mockResolvedValue([]);
  mocks.generateTextLocal.mockResolvedValue({
    text: "Photorealistic studio portrait.",
    model: "llama",
  });
});

describe("optimizePrompt", () => {
  it("forwards abortSignal to planned local attempts", async () => {
    const abortSignal = new AbortController().signal;

    await expect(
      optimizePrompt({
        prompt: "portrait",
        mode: "photo",
        abortSignal,
      }),
    ).resolves.toEqual({
      provider: "local",
      model: "llama",
      optimizedPrompt: "Photorealistic studio portrait.",
    });

    expect(mocks.generateTextLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal,
      }),
    );
  });
});
