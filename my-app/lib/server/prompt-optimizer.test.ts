import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateTextLocal: vi.fn(),
  generateTextByok: vi.fn(),
  resolveTextRuntimeSupply: vi.fn(),
}));

vi.mock("@/lib/server/local-llm", () => ({
  generateTextLocal: mocks.generateTextLocal,
}));

vi.mock("@/lib/server/byok-llm", () => ({
  generateTextByok: mocks.generateTextByok,
}));

vi.mock("@/lib/server/runtime-supply", () => ({
  resolveTextRuntimeSupply: mocks.resolveTextRuntimeSupply,
}));

import { optimizePrompt } from "@/lib/server/prompt-optimizer";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTextRuntimeSupply.mockResolvedValue({
    backend: "local",
    endpoint: "http://localhost:11434",
    modelId: "llama",
  });
  mocks.generateTextLocal.mockResolvedValue({
    text: "Photorealistic studio portrait.",
    model: "llama",
  });
});

describe("optimizePrompt", () => {
  it("fails explicitly when no text runtime is configured", async () => {
    mocks.resolveTextRuntimeSupply.mockResolvedValue(null);

    await expect(
      optimizePrompt({
        prompt: "portrait",
        mode: "photo",
        textModelId: "local:llama",
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "prompt_optimizer_unavailable",
      retryable: true,
    });
    expect(mocks.generateTextLocal).not.toHaveBeenCalled();
    expect(mocks.generateTextByok).not.toHaveBeenCalled();
  });

  it("passes the explicit text model into resolveTextRuntimeSupply", async () => {
    await optimizePrompt({
      prompt: "portrait",
      mode: "photo",
      textModelId: "local:wanted-model",
    });

    expect(mocks.resolveTextRuntimeSupply).toHaveBeenCalledWith("local:wanted-model");
    expect(mocks.generateTextLocal).toHaveBeenCalled();
  });

  it("does not disguise an invalid Chinese result as a rule-based success", async () => {
    mocks.generateTextLocal.mockResolvedValue({
      text: "English output without the requested subject.",
      model: "llama",
    });

    await expect(
      optimizePrompt({
        prompt: "月光下的天文台",
        mode: "concept",
        locale: "zh-CN",
        textModelId: "local:llama",
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "prompt_optimizer_invalid_output",
      retryable: true,
    });
    expect(mocks.generateTextLocal).toHaveBeenCalledTimes(2);
  });

  it("forwards abortSignal to planned local attempts", async () => {
    const abortSignal = new AbortController().signal;

    await expect(
      optimizePrompt({
        prompt: "portrait",
        mode: "photo",
        textModelId: "local:llama",
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
