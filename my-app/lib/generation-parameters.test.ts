import { describe, expect, it } from "vitest";
import {
  generationAssetProvenance,
  normalizeGenerationParameters,
} from "@/lib/generation-parameters";

describe("generation parameters", () => {
  it("normalizes parameters to the supported engine envelope", () => {
    expect(normalizeGenerationParameters({
      seed: 3_000_000_000,
      steps: 200,
      cfg: -2,
      negativePrompt: "  blur  ",
    })).toEqual({
      seed: 2_147_483_647,
      steps: 150,
      cfg: 0,
      negativePrompt: "blur",
    });
  });

  it("maps the actual per-image parameters into Asset persistence fields", () => {
    expect(generationAssetProvenance({
      seed: 4242,
      steps: 28,
      cfg: 5.5,
      negativePrompt: "blur, watermark",
      modelId: "sdxl-base-1.0",
    }, "fallback-model")).toEqual({
      generationSeed: 4242,
      generationSteps: 28,
      generationCfg: 5.5,
      negativePrompt: "blur, watermark",
      generationModel: "sdxl-base-1.0",
    });
  });

  it("always records the resolved model even when a provider omits optional parameters", () => {
    expect(generationAssetProvenance(undefined, "provider-model-id")).toEqual({
      generationSeed: undefined,
      generationSteps: undefined,
      generationCfg: undefined,
      negativePrompt: undefined,
      generationModel: "provider-model-id",
    });
  });
});
