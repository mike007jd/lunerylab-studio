import { describe, expect, it } from "vitest";
import {
  ALL_ADVANCED_IMAGE_PARAMETERS,
  NO_ADVANCED_IMAGE_PARAMETERS,
  NO_DEFAULT_IMAGE_MODEL_ID,
  VERIFIED_IMAGE_ADVANCED_PARAMETER_RECORDS,
  byokImageAdvancedParameters,
  filterGenerationParametersToCapabilities,
  findVerifiedImageAdvancedParameterRecord,
  resolveImageAdvancedParameters,
  supportsAnyAdvancedImageParameter,
  type ImageModelEntry,
} from "./image-models";

const imageModel: ImageModelEntry = {
  id: "byok:openai:gpt-image-1.5",
  providerModelId: "gpt-image-1.5",
  apiMode: "image",
  brand: "OpenAI",
  brandZh: "OpenAI",
  label: "GPT Image 1.5",
  labelZh: "GPT Image 1.5",
  tier: "premium",
  supportsEdit: true,
  supportsAspectRatio: true,
  source: "byok",
};

describe("image model defaults", () => {
  it("does not invent an implicit default from the catalog", () => {
    expect(imageModel.id).not.toBe(NO_DEFAULT_IMAGE_MODEL_ID);
    expect(NO_DEFAULT_IMAGE_MODEL_ID).toBe("");
  });
});

describe("image advanced parameter capabilities", () => {
  const allParameters = {
    seed: 4242,
    steps: 28,
    cfg: 5.5,
    negativePrompt: "blur",
  };

  it("hides all advanced fields for OpenAI and openai-compatible models", () => {
    expect(byokImageAdvancedParameters("openai-rest", "gpt-image-1.5")).toEqual(
      NO_ADVANCED_IMAGE_PARAMETERS,
    );
    expect(byokImageAdvancedParameters("openai-compatible", "custom/image")).toEqual(
      NO_ADVANCED_IMAGE_PARAMETERS,
    );
    expect(supportsAnyAdvancedImageParameter(NO_ADVANCED_IMAGE_PARAMETERS)).toBe(false);
    expect(
      filterGenerationParametersToCapabilities(allParameters, NO_ADVANCED_IMAGE_PARAMETERS),
    ).toEqual({});
  });

  it("supports the full set for local runnable image models", () => {
    expect(
      resolveImageAdvancedParameters({
        id: "local-sdxl",
        providerModelId: "local-sdxl",
        source: "local",
      }),
    ).toEqual(ALL_ADVANCED_IMAGE_PARAMETERS);
  });

  it("exposes current provenance for every exact verified record", () => {
    expect(VERIFIED_IMAGE_ADVANCED_PARAMETER_RECORDS).toHaveLength(4);
    expect(
      VERIFIED_IMAGE_ADVANCED_PARAMETER_RECORDS.every(
        ({ checkedAt, sourceUrl }) =>
          checkedAt === "2026-07-23" && sourceUrl.startsWith("https://"),
      ),
    ).toBe(true);
    expect(
      VERIFIED_IMAGE_ADVANCED_PARAMETER_RECORDS.some(({ modelId }) =>
        modelId.includes("layer-diffusion"),
      ),
    ).toBe(false);
    expect(
      findVerifiedImageAdvancedParameterRecord(
        "replicate",
        "black-forest-labs/flux-2-pro",
      ),
    ).toMatchObject({
      sourceUrl: "https://replicate.com/black-forest-labs/flux-2-pro/api/schema",
      checkedAt: "2026-07-23",
    });
  });

  it("supports only the verified controls for exact Replicate and Fal records", () => {
    const seedOnly = {
      seed: true,
      steps: false,
      cfg: false,
      negativePrompt: false,
    };
    expect(
      byokImageAdvancedParameters("replicate", "black-forest-labs/flux-2-pro"),
    ).toEqual(seedOnly);
    expect(byokImageAdvancedParameters("fal", "fal-ai/flux-pro/v1.1")).toEqual(seedOnly);
    expect(byokImageAdvancedParameters("fal", "fal-ai/flux-pro/v1/fill")).toEqual(seedOnly);
    expect(byokImageAdvancedParameters("fal", "fal-ai/flux-pulid")).toEqual(
      ALL_ADVANCED_IMAGE_PARAMETERS,
    );
    expect(
      filterGenerationParametersToCapabilities(
        allParameters,
        byokImageAdvancedParameters("fal", "fal-ai/flux-pro/v1.1"),
      ),
    ).toEqual({ seed: 4242 });
  });

  it("does not infer capabilities from family-like or deprecated model ids", () => {
    for (const [mode, modelId] of [
      ["replicate", "stability-ai/sdxl"],
      ["replicate", "owner/flux-2-pro"],
      ["fal", "fal-ai/flux/dev"],
      ["fal", "fal-ai/stable-diffusion-v3"],
      ["fal", "fal-ai/layer-diffusion"],
    ] as const) {
      expect(byokImageAdvancedParameters(mode, modelId)).toEqual(
        NO_ADVANCED_IMAGE_PARAMETERS,
      );
    }
  });

  it("defaults unknown BYOK rows to no advanced fields", () => {
    expect(
      resolveImageAdvancedParameters({
        id: "byok:unknown-provider:model",
        providerModelId: "model",
        source: "byok",
      }),
    ).toEqual(NO_ADVANCED_IMAGE_PARAMETERS);
    expect(byokImageAdvancedParameters("none", "anything")).toEqual(NO_ADVANCED_IMAGE_PARAMETERS);
  });

  it("derives BYOK capabilities from the catalog id without a stamped field", () => {
    expect(
      resolveImageAdvancedParameters({
        id: "byok:fal:fal-ai/flux-pulid",
        providerModelId: "fal-ai/flux-pulid",
        source: "byok",
      }),
    ).toEqual(ALL_ADVANCED_IMAGE_PARAMETERS);
    expect(
      resolveImageAdvancedParameters({
        id: "byok:openai:gpt-image-1.5",
        providerModelId: "gpt-image-1.5",
        source: "byok",
      }),
    ).toEqual(NO_ADVANCED_IMAGE_PARAMETERS);
  });
});
