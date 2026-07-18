import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  const openAiImageModel = vi.fn((modelId: string) => ({ provider: "openai", modelId }));
  const compatibleImageModel = vi.fn((modelId: string) => ({
    provider: "openai-compatible",
    modelId,
  }));
  return {
    generateImage: vi.fn(),
    createOpenAI: vi.fn(() => ({ imageModel: openAiImageModel })),
    createOpenAICompatible: vi.fn(() => ({ imageModel: compatibleImageModel })),
    openAiImageModel,
    compatibleImageModel,
  };
});

vi.mock("ai", () => ({
  generateImage: mocks.generateImage,
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: mocks.createOpenAI,
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}));

import {
  generateImagesOpenAiCompatible,
  generateImagesOpenAiEdit,
  generateImagesOpenAiRest,
  type ResolvedByokConfig,
} from "@/lib/server/byok-image-adapters";

const config: ResolvedByokConfig = {
  apiKey: "test-key",
  endpoint: "https://api.example.test/v1",
  modelId: "gpt-image-2",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateImage.mockResolvedValue({
    images: [
      {
        uint8Array: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
      },
    ],
  });
});

describe("BYOK OpenAI image adapters", () => {
  it("uses AI SDK imageModel for OpenAI image generation", async () => {
    const images = await generateImagesOpenAiRest(config, {
      prompt: "make a poster",
      count: 2,
      aspectRatio: "1:1",
    });

    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      apiKey: "test-key",
      baseURL: "https://api.example.test/v1",
    });
    expect(mocks.openAiImageModel).toHaveBeenCalledWith("gpt-image-2");
    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "make a poster",
        n: 2,
        size: "1024x1024",
      }),
    );
    expect(images).toEqual([{ bytes: Buffer.from([1, 2, 3]), mimeType: "image/png" }]);
  });

  it("uses AI SDK edit prompt files for OpenAI image editing", async () => {
    await generateImagesOpenAiEdit(config, {
      prompt: "change the background",
      count: 1,
      aspectRatio: "16:9",
      isEdit: true,
      references: [Buffer.from([1, 2, 3])],
    });

    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        n: 1,
        size: "1536x1024",
        prompt: expect.objectContaining({
          text: "change the background",
          images: [Buffer.from([1, 2, 3])],
        }),
      }),
    );
  });

  it("uses AI SDK openai-compatible imageModel with provider size options", async () => {
    await generateImagesOpenAiCompatible(
      { ...config, modelId: "custom/image-model" },
      {
        prompt: "make a product shot",
        count: 1,
        aspectRatio: "9:16",
      },
    );

    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith({
      name: "openai-compatible",
      baseURL: "https://api.example.test/v1",
      apiKey: "test-key",
    });
    expect(mocks.compatibleImageModel).toHaveBeenCalledWith("custom/image-model");
    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "make a product shot",
        size: "1024x1536",
        providerOptions: {
          "openai-compatible": { width: 1024, height: 1536 },
        },
      }),
    );
  });
});
