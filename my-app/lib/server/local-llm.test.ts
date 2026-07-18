import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  createOpenAICompatible: vi.fn(),
  modelFactory: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
}));

vi.mock("server-only", () => ({}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}));

import { generateTextLocal } from "@/lib/server/local-llm";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.modelFactory.mockReturnValue({ provider: "local", modelId: "llama" });
  mocks.createOpenAICompatible.mockReturnValue(mocks.modelFactory);
});

describe("local LLM wrapper", () => {
  it("forwards abortSignal to AI SDK text generation", async () => {
    const abortSignal = new AbortController().signal;
    mocks.generateText.mockResolvedValue({ text: " optimized prompt " });

    await expect(
      generateTextLocal({
        systemPrompt: "system",
        userPrompt: "user",
        endpoint: "http://localhost:11434",
        modelId: "llama",
        abortSignal,
      }),
    ).resolves.toEqual({ text: "optimized prompt", model: "llama" });

    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal,
      }),
    );
  });
});
