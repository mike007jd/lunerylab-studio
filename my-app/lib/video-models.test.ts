import { describe, expect, it } from "vitest";
import { normalizeDuration, type VideoModelEntry } from "@/lib/video-models";

const baseModel = {
  id: "byok:test:model",
  providerModelId: "provider/model",
  brand: "Test",
  brandZh: "Test",
  label: "Test model",
  labelZh: "Test model",
  tier: "standard",
  supportsImageInput: false,
  requiresImageInput: false,
} satisfies Omit<VideoModelEntry, "durationMode" | "durationOptions" | "durationRange">;

const rangeModel: VideoModelEntry = {
  ...baseModel,
  durationMode: "range",
  durationRange: [4, 12],
};

const discreteModel: VideoModelEntry = {
  ...baseModel,
  durationMode: "discrete",
  durationOptions: [4, 6, 10],
};

describe("normalizeDuration", () => {
  it("clamps and rounds range durations", () => {
    expect(normalizeDuration(rangeModel, 1)).toBe(4);
    expect(normalizeDuration(rangeModel, 7.6)).toBe(8);
    expect(normalizeDuration(rangeModel, 12.6)).toBe(12);
  });

  it("uses the range minimum for non-finite durations", () => {
    expect(normalizeDuration(rangeModel, Number.NaN)).toBe(4);
    expect(normalizeDuration(rangeModel, Number.POSITIVE_INFINITY)).toBe(4);
  });

  it("selects the nearest discrete duration", () => {
    expect(normalizeDuration(discreteModel, 7)).toBe(6);
    expect(normalizeDuration(discreteModel, 9)).toBe(10);
  });

  it("uses the first discrete option for non-finite durations", () => {
    expect(normalizeDuration(discreteModel, Number.NaN)).toBe(4);
  });
});
