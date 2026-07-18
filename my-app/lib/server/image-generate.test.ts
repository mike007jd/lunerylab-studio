import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  resolveImageGenerationTarget: vi.fn(),
  isKnownLocalImageModelId: vi.fn(),
  generateImagesByok: vi.fn(),
  generateImagesLocal: vi.fn(),
  generateImagesLocalSd: vi.fn(),
}));

vi.mock("@/lib/server/runtime-supply", () => ({
  resolveImageGenerationTarget: mocks.resolveImageGenerationTarget,
}));

vi.mock("@/lib/server/local-image-model-catalog", () => ({
  isKnownLocalImageModelId: mocks.isKnownLocalImageModelId,
}));

vi.mock("@/lib/server/byok-image", () => ({
  generateImagesByok: mocks.generateImagesByok,
}));

vi.mock("@/lib/server/local-image", () => ({
  generateImagesLocal: mocks.generateImagesLocal,
}));

vi.mock("@/lib/server/local-sd", () => ({
  generateImagesLocalSd: mocks.generateImagesLocalSd,
}));

import { generateImages } from "@/lib/server/image-generate";

describe("generateImages", () => {
  it("rejects empty model ids before resolving a runtime target", async () => {
    await expect(
      generateImages({
        prompt: "make an image",
        modelId: "   ",
        count: 1,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "no_model_selected",
      retryable: false,
    });

    expect(mocks.resolveImageGenerationTarget).not.toHaveBeenCalled();
  });
});
