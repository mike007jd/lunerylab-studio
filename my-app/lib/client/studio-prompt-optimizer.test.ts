import { describe, expect, it } from "vitest";
import {
  buildStudioPromptOptimizePayload,
  promptOptimizeNoticeKey,
  resolvePromptOptimizeVideoModelId,
  validateStudioPromptOptimizeInput,
} from "./studio-prompt-optimizer";

const videoModels = [
  {
    id: "byok:fal:seedance",
    providerModelId: "bytedance/seedance-2.0/text-to-video",
  },
  {
    id: "byok:fal:veo",
    providerModelId: "google/veo-3.1/text-to-video",
  },
];

describe("studio prompt optimizer helpers", () => {
  it("returns the UI validation key before a network request is built", () => {
    expect(
      validateStudioPromptOptimizeInput({
        canRefinePrompt: false,
        prompt: "portrait",
        hasSelectedPreset: false,
      }),
    ).toBe("studio.setupHint.refineDisabled");

    expect(
      validateStudioPromptOptimizeInput({
        canRefinePrompt: true,
        prompt: "   ",
        hasSelectedPreset: false,
      }),
    ).toBe("studio.promptRequired");

    expect(
      validateStudioPromptOptimizeInput({
        canRefinePrompt: true,
        prompt: "   ",
        hasSelectedPreset: true,
      }),
    ).toBeNull();
  });

  it("uses the internal video model id even when the selected value is provider-facing", () => {
    expect(
      resolvePromptOptimizeVideoModelId({
        generationType: "video",
        videoModels,
        selectedVideoModelId: "google/veo-3.1/text-to-video",
      }),
    ).toBe("byok:fal:veo");
  });

  it("omits video-only fields for image prompt optimization", () => {
    expect(
      buildStudioPromptOptimizePayload({
        prompt: "portrait",
        mode: "photo",
        referenceCount: 2,
        locale: "en",
        generationType: "image",
        videoModels,
        selectedVideoModelId: "byok:fal:seedance",
        videoDuration: 6,
        presetName: "Editorial",
        presetGuidance: "Natural light.",
      }),
    ).toEqual({
      prompt: "portrait",
      mode: "photo",
      referenceCount: 2,
      locale: "en",
      generationType: "image",
      videoModelId: undefined,
      videoDuration: undefined,
      presetName: "Editorial",
      presetGuidance: "Natural light.",
    });
  });

  it("keeps video duration and canonical video model id for video optimization", () => {
    expect(
      buildStudioPromptOptimizePayload({
        prompt: "runway shot",
        mode: "photo",
        referenceCount: 1,
        locale: "zh-CN",
        generationType: "video",
        videoModels,
        selectedVideoModelId: "byok:fal:seedance",
        videoDuration: 8,
      }),
    ).toMatchObject({
      generationType: "video",
      videoModelId: "byok:fal:seedance",
      videoDuration: 8,
    });
  });

  it("surfaces rule fallback as a distinct notice key", () => {
    expect(promptOptimizeNoticeKey("rule-fallback")).toBe("studio.promptRuleFallback");
    expect(promptOptimizeNoticeKey("local")).toBe("studio.promptOptimized");
    expect(promptOptimizeNoticeKey("byok")).toBe("studio.promptOptimized");
  });
});
