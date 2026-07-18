import { describe, expect, it } from "vitest";
import type { ImageModelEntry } from "@/lib/image-models";
import type { VideoModelEntry } from "@/lib/video-models";
import {
  resolveSelectableImageModelId,
  resolveSelectableVideoModelId,
} from "./use-model-catalog";

const imageModels: ImageModelEntry[] = [
  {
    id: "local:flux1-schnell-q4",
    providerModelId: "flux1-schnell-q4",
    apiMode: "image",
    brand: "Local",
    brandZh: "本地",
    label: "FLUX",
    labelZh: "FLUX",
    tier: "standard",
    supportsEdit: false,
    supportsAspectRatio: true,
    source: "local",
  },
];

const secondImageModel: ImageModelEntry = {
  id: "byok:openai:test-image-model",
  providerModelId: "test-image-model",
  apiMode: "image",
  brand: "OpenAI",
  brandZh: "OpenAI",
  label: "GPT Image",
  labelZh: "GPT Image",
  tier: "premium",
  supportsEdit: true,
  supportsAspectRatio: true,
  source: "byok",
};

const videoModels: VideoModelEntry[] = [
  {
    id: "byok:fal:seedance",
    providerModelId: "bytedance/seedance-2.0/text-to-video",
    brand: "Seedance",
    brandZh: "Seedance",
    label: "Seedance text to video",
    labelZh: "Seedance text to video",
    tier: "standard",
    durationMode: "range",
    durationRange: [4, 15],
    supportsImageInput: false,
    requiresImageInput: false,
    source: "byok",
  },
  {
    id: "byok:fal:seedance-i2v",
    providerModelId: "bytedance/seedance-2.0/image-to-video",
    brand: "Seedance",
    brandZh: "Seedance",
    label: "Seedance image to video",
    labelZh: "Seedance image to video",
    tier: "standard",
    durationMode: "range",
    durationRange: [4, 15],
    supportsImageInput: true,
    requiresImageInput: true,
    source: "byok",
  },
];

describe("model selection helpers", () => {
  it("keeps image selection empty with multiple choices unless requested or persisted model exists", () => {
    const choices = [...imageModels, secondImageModel];
    expect(resolveSelectableImageModelId(choices, undefined, "")).toBe("");
    expect(resolveSelectableImageModelId(choices, "missing", "")).toBe("");
    expect(resolveSelectableImageModelId(choices, undefined, "local:flux1-schnell-q4")).toBe("local:flux1-schnell-q4");
    expect(resolveSelectableImageModelId(choices, "local:flux1-schnell-q4", "")).toBe("local:flux1-schnell-q4");
  });

  it("selects the only image model because there is no user choice to guess", () => {
    expect(resolveSelectableImageModelId(imageModels, undefined, "")).toBe("local:flux1-schnell-q4");
  });

  it("rejects image-to-video models when no reference image is available", () => {
    expect(resolveSelectableVideoModelId(videoModels, "byok:fal:seedance-i2v", { hasReferenceImage: false })).toBe("");
    expect(resolveSelectableVideoModelId(videoModels, "byok:fal:seedance-i2v", { hasReferenceImage: true })).toBe(
      "byok:fal:seedance-i2v",
    );
    expect(resolveSelectableVideoModelId(videoModels, "byok:fal:seedance", { hasReferenceImage: false })).toBe(
      "byok:fal:seedance",
    );
  });
});
