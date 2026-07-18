import { describe, expect, it } from "vitest";
import { NO_DEFAULT_IMAGE_MODEL_ID, type ImageModelEntry } from "./image-models";

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
