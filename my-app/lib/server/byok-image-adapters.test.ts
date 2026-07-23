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
    runReplicatePrediction: vi.fn(),
    falQueueResult: vi.fn(),
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

vi.mock("@/lib/server/byok-provider-clients", () => ({
  runReplicatePrediction: mocks.runReplicatePrediction,
  falQueueResult: mocks.falQueueResult,
}));

import {
  generateImagesOpenAiCompatible,
  generateImagesOpenAiEdit,
  generateImagesOpenAiRest,
  generateImagesFal,
  generateImagesReplicate,
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
  mocks.runReplicatePrediction.mockResolvedValue({ output: [] });
  mocks.falQueueResult.mockResolvedValue({ images: [] });
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

  it("does not send diffusion-only parameters to OpenAI image models", async () => {
    await generateImagesOpenAiRest(config, {
      prompt: "make a poster",
      count: 1,
      generationParameters: {
        seed: 4242,
        steps: 28,
        cfg: 5.5,
        negativePrompt: "blur",
      },
    });

    const sdkInput = mocks.generateImage.mock.calls[0]?.[0];
    expect(sdkInput).not.toHaveProperty("seed");
    expect(sdkInput).not.toHaveProperty("steps");
    expect(sdkInput).not.toHaveProperty("cfg");
    expect(sdkInput).not.toHaveProperty("negativePrompt");
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

describe("BYOK diffusion parameter capabilities", () => {
  const parameters = {
    seed: 4242,
    steps: 28,
    cfg: 5.5,
    negativePrompt: "blur, watermark",
  };

  it("sends only verified seed support to the exact Replicate schema", async () => {
    await expect(generateImagesReplicate(
      { ...config, modelId: "black-forest-labs/flux-2-pro" },
      { prompt: "poster", count: 1, generationParameters: parameters },
    )).rejects.toThrow("returned no image URLs");

    const providerInput = mocks.runReplicatePrediction.mock.calls[0]?.[0]?.input;
    expect(providerInput).toMatchObject({ seed: 4242 });
    expect(providerInput).not.toHaveProperty("num_inference_steps");
    expect(providerInput).not.toHaveProperty("guidance_scale");
    expect(providerInput).not.toHaveProperty("negative_prompt");
  });

  it("omits unsupported parameters for unverified family-like Replicate models", async () => {
    await expect(generateImagesReplicate(
      { ...config, modelId: "stability-ai/sdxl" },
      { prompt: "poster", count: 1, generationParameters: parameters },
    )).rejects.toThrow("returned no image URLs");

    const providerInput = mocks.runReplicatePrediction.mock.calls[0]?.[0]?.input;
    expect(providerInput).not.toHaveProperty("seed");
    expect(providerInput).not.toHaveProperty("num_inference_steps");
    expect(providerInput).not.toHaveProperty("guidance_scale");
    expect(providerInput).not.toHaveProperty("negative_prompt");
  });

  it("sends only verified seed support to an exact Fal schema", async () => {
    await expect(generateImagesFal(
      { ...config, modelId: "fal-ai/flux-pro/v1.1" },
      { prompt: "poster", count: 1, generationParameters: parameters },
    )).rejects.toThrow("returned no images");

    const body = mocks.falQueueResult.mock.calls[0]?.[0]?.body;
    expect(body).toMatchObject({ seed: 4242 });
    expect(body).not.toHaveProperty("num_inference_steps");
    expect(body).not.toHaveProperty("guidance_scale");
    expect(body).not.toHaveProperty("negative_prompt");
  });

  it("forwards every verified control for the exact Fal PuLID schema", async () => {
    await expect(generateImagesFal(
      { ...config, modelId: "fal-ai/flux-pulid" },
      { prompt: "poster", count: 1, generationParameters: parameters },
    )).rejects.toThrow("returned no images");

    expect(mocks.falQueueResult.mock.calls[0]?.[0]?.body).toMatchObject({
      seed: 4242,
      num_inference_steps: 28,
      guidance_scale: 5.5,
      negative_prompt: "blur, watermark",
    });
  });
});
