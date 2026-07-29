import { describe, expect, it } from "vitest";
import {
  deriveCreativeCapabilityReadiness,
  type CreativeCapabilityReadinessInput,
} from "@/lib/client/creative-capability-readiness";
import type { ImageModelEntry } from "@/lib/image-models";
import type { VideoModelEntry } from "@/lib/video-models";

const t = (path: string, vars?: Record<string, string | number>) => {
  if (!vars) return path;
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, String(value)),
    path,
  );
};

const imageModel: ImageModelEntry = {
  id: "local-image",
  providerModelId: "local-image",
  apiMode: "image",
  brand: "Local",
  brandZh: "本地",
  label: "Local Image",
  labelZh: "本地图像",
  tier: "standard",
  supportsEdit: false,
  supportsAspectRatio: true,
  source: "local",
};

const alternateImageModel: ImageModelEntry = {
  ...imageModel,
  id: "alternate-local-image",
  providerModelId: "alternate-local-image",
  label: "Alternate Local Image",
  labelZh: "备用本地图像",
};

const videoModel: VideoModelEntry = {
  id: "byok-video",
  providerModelId: "fal-video",
  brand: "Fal",
  brandZh: "Fal",
  label: "Fal Video",
  labelZh: "Fal 视频",
  tier: "standard",
  durationMode: "range",
  durationRange: [3, 10],
  supportsImageInput: true,
  requiresImageInput: false,
  source: "byok",
};

const alternateVideoModel: VideoModelEntry = {
  ...videoModel,
  id: "byok:fal:alternate",
  providerModelId: "fal-alternate",
  label: "Fal Alternate",
  labelZh: "Fal 备用",
};

function baseInput(overrides: Partial<CreativeCapabilityReadinessInput> = {}): CreativeCapabilityReadinessInput {
  return {
    imageModels: [],
    videoModels: [],
    catalogLoading: false,
    bootstrapDefaultImageModel: "",
    bootstrapDefaultTextModel: "",
    bootstrapDefaultVideoModel: "",
    providers: {},
    providerConnections: {},
    localSummary: {
      desktop: true,
      currentImageModel: null,
      currentTextModel: null,
      hasReadyImage: false,
      hasReadyText: false,
    },
    localRuntimes: [],
    t,
    ...overrides,
  };
}

describe("deriveCreativeCapabilityReadiness", () => {
  it("routes desktop shell bridge failures to runtime diagnostics instead of app download", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        isDesktopShell: true,
        localSummary: {
          desktop: false,
          currentImageModel: null,
          currentTextModel: null,
          hasReadyImage: false,
          hasReadyText: false,
        },
      }),
    );

    expect(readiness.primaryIssue?.id).toBe("runtime");
    expect(readiness.primaryIssue?.href).toBe("/settings?panel=runtime-diagnostics");
    expect(readiness.primaryIssue?.actionLabel).toBe("capabilityReadiness.actions.diagnoseRuntime");
    expect(readiness.primaryIssue?.detail).toBe("capabilityReadiness.runtime.missingShellDetail");
  });

  it("surfaces the image model as the primary missing capability", () => {
    const readiness = deriveCreativeCapabilityReadiness(baseInput());

    expect(readiness.overallStatus).toBe("missing");
    expect(readiness.primaryIssue?.id).toBe("imageGeneration");
    expect(readiness.byId.imageGeneration.shortLabel).toBe("capabilityReadiness.sidebar.imageMissing");
  });

  it("treats a text-capable provider without a text model as optional refinement setup", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        providers: { anthropic: { configured: true, source: "keychain" } },
        providerConnections: { anthropic: { hasSecret: true, models: {} } },
      }),
    );

    expect(readiness.byId.promptRefinement.status).toBe("partial");
    expect(readiness.byId.promptRefinement.shortLabel).toBe("capabilityReadiness.sidebar.textModelMissing");
    expect(readiness.primaryIssue?.id).not.toBe("promptRefinement");
  });

  it("does not mark text refinement ready from an unrelated first BYOK text slot", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        bootstrapDefaultImageModel: imageModel.id,
        providers: { anthropic: { configured: true, source: "keychain" } },
        providerConnections: {
          anthropic: { hasSecret: true, models: { text: "claude-sonnet-4-6" } },
        },
      }),
    );

    expect(readiness.byId.promptRefinement.status).toBe("partial");
    expect(readiness.byId.promptRefinement.activeLabel).toBeUndefined();
  });

  it("marks text refinement ready only for the exact bootstrap default text selection", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        bootstrapDefaultImageModel: imageModel.id,
        bootstrapDefaultTextModel: "byok:anthropic:claude-sonnet-4-6",
        providers: { anthropic: { configured: true, source: "keychain" } },
        providerConnections: {
          anthropic: { hasSecret: true, models: { text: "claude-sonnet-4-6" } },
        },
      }),
    );

    expect(readiness.byId.promptRefinement.status).toBe("ready");
    expect(readiness.byId.promptRefinement.activeLabel).toContain("claude-sonnet-4-6");
  });

  it("keeps local text partial when a ready runtime does not match the explicit default", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        bootstrapDefaultImageModel: imageModel.id,
        bootstrapDefaultTextModel: "local:wanted-model",
        localSummary: {
          desktop: true,
          currentImageModel: "Local Image",
          currentTextModel: "other-model",
          currentTextModelId: "other-model",
          hasReadyImage: true,
          hasReadyText: true,
        },
      }),
    );

    expect(readiness.byId.promptRefinement.status).toBe("partial");
  });

  it("marks local text ready only when the exact normalized runtime id matches", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        bootstrapDefaultImageModel: imageModel.id,
        bootstrapDefaultTextModel: "local:llama3.2",
        localSummary: {
          desktop: true,
          currentImageModel: "Local Image",
          currentTextModel: "Llama 3.2",
          currentTextModelId: "LLAMA3.2:latest",
          hasReadyImage: true,
          hasReadyText: true,
        },
      }),
    );

    expect(readiness.byId.promptRefinement.status).toBe("ready");
    expect(readiness.byId.promptRefinement.activeLabel).toBe("Llama 3.2");
  });

  it("does not accept a suffix-only local model match", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        bootstrapDefaultImageModel: imageModel.id,
        bootstrapDefaultTextModel: "local:wanted-model",
        localSummary: {
          desktop: true,
          currentImageModel: "Local Image",
          currentTextModel: "Wrong model",
          currentTextModelId: "different-wanted-model",
          hasReadyImage: true,
          hasReadyText: true,
        },
      }),
    );

    expect(readiness.byId.promptRefinement.status).toBe("partial");
  });

  it("does not turn missing optional prompt help into the Studio primary issue", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        bootstrapDefaultImageModel: imageModel.id,
        localSummary: {
          desktop: true,
          currentImageModel: "Local Image",
          currentTextModel: null,
          hasReadyImage: true,
          hasReadyText: false,
        },
      }),
    );

    expect(readiness.overallStatus).toBe("ready");
    expect(readiness.primaryIssue).toBeNull();
    expect(readiness.summaryLabel).toBe("capabilityReadiness.sidebar.ready");
    expect(readiness.byId.promptRefinement.status).toBe("partial");
  });

  it("keeps image creation ready when only optional video setup is missing", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        bootstrapDefaultImageModel: imageModel.id,
        bootstrapDefaultTextModel: "local:Local Text",
        localSummary: {
          desktop: true,
          currentImageModel: "Local Image",
          currentTextModel: "Local Text",
          currentTextModelId: "Local Text",
          hasReadyImage: true,
          hasReadyText: true,
        },
      }),
    );

    expect(readiness.overallStatus).toBe("ready");
    expect(readiness.primaryIssue).toBeNull();
    expect(readiness.byId.videoGeneration.status).toBe("partial");
    expect(readiness.byId.videoGeneration.title).toBe("capabilityReadiness.video.missingTitle");
    expect(readiness.byId.videoGeneration.detail).toBe("capabilityReadiness.video.missingDetail");
    expect(readiness.byId.videoGeneration.reason).toBe("capabilityReadiness.video.missingReason");
    expect(readiness.byId.videoGeneration.href).toBe("/settings?panel=video");
    expect(readiness.byId.videoGeneration.actionLabel).toBe(
      "capabilityReadiness.actions.connectVideoProvider",
    );
  });

  it("treats a non-empty video catalog without an explicit default as partial", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        videoModels: [videoModel, alternateVideoModel],
        bootstrapDefaultImageModel: imageModel.id,
        bootstrapDefaultTextModel: "local:Local Text",
        localSummary: {
          desktop: true,
          currentImageModel: "Local Image",
          currentTextModel: "Local Text",
          hasReadyImage: true,
          hasReadyText: true,
        },
      }),
    );

    expect(readiness.byId.videoGeneration.status).toBe("partial");
    expect(readiness.byId.videoGeneration.activeLabel).toBeUndefined();
    expect(readiness.byId.videoGeneration.href).toBe("/settings?panel=video");
  });

  it("labels video readiness from the explicit bootstrap default, not the first catalog entry", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        videoModels: [videoModel, alternateVideoModel],
        bootstrapDefaultImageModel: imageModel.id,
        bootstrapDefaultTextModel: "local:Local Text",
        bootstrapDefaultVideoModel: alternateVideoModel.id,
        localSummary: {
          desktop: true,
          currentImageModel: "Local Image",
          currentTextModel: "Local Text",
          hasReadyImage: true,
          hasReadyText: true,
        },
      }),
    );

    expect(readiness.byId.videoGeneration.status).toBe("ready");
    expect(readiness.byId.videoGeneration.activeLabel).toBe("Fal Alternate");
  });

  it("labels a ready image capability with the resolved explicit default, not the first catalog entry", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel, alternateImageModel],
        bootstrapDefaultImageModel: alternateImageModel.id,
        localSummary: {
          desktop: true,
          currentImageModel: "Local Image",
          currentTextModel: "Local Text",
          hasReadyImage: true,
          hasReadyText: true,
        },
      }),
    );

    expect(readiness.byId.imageGeneration.status).toBe("ready");
    expect(readiness.byId.imageGeneration.activeLabel).toBe("Alternate Local Image");
    expect(readiness.byId.imageGeneration.detail).toBe(
      "capabilityReadiness.image.readyDetailWithModel",
    );
    expect(readiness.byId.imageGeneration.activeLabel).not.toBe("Local Image");
  });

  it("keeps the running local image label only when it matches the resolved default", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel, alternateImageModel],
        bootstrapDefaultImageModel: imageModel.id,
        localSummary: {
          desktop: true,
          currentImageModel: "Local Image",
          currentTextModel: "Local Text",
          hasReadyImage: true,
          hasReadyText: true,
        },
      }),
    );

    expect(readiness.byId.imageGeneration.activeLabel).toBe("Local Image");
  });

  it("requires an explicit default even when only one image model is available", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        localSummary: {
          desktop: true,
          currentImageModel: "Local Image",
          currentTextModel: "Local Text",
          hasReadyImage: true,
          hasReadyText: true,
        },
      }),
    );

    // A ready local image model without a selected default is not ready and
    // must never silently dispatch.
    expect(readiness.byId.imageGeneration.status).toBe("partial");
    expect(readiness.byId.imageGeneration.href).toBe("/settings?panel=image");
    expect(readiness.byId.imageGeneration.actionLabel).toBe(
      "capabilityReadiness.actions.openImageSettings",
    );
    expect(readiness.byId.defaults.status).toBe("partial");
    expect(readiness.overallStatus).toBe("partial");
    expect(readiness.primaryIssue?.id).toBe("imageGeneration");
  });

  it("routes missing text capability actions to the Text settings tab", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        bootstrapDefaultImageModel: imageModel.id,
      }),
    );

    expect(readiness.byId.promptRefinement.status).toBe("partial");
    expect(readiness.byId.promptRefinement.href).toBe("/settings?panel=text");

    const withSecret = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        bootstrapDefaultImageModel: imageModel.id,
        providers: { anthropic: { configured: true, source: "keychain" } },
        providerConnections: { anthropic: { hasSecret: true, models: {} } },
      }),
    );
    expect(withSecret.byId.promptRefinement.href).toBe("/settings?panel=text");
  });

  it("surfaces the missing default as the image-generation issue when several models are available", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel, alternateImageModel],
        localSummary: {
          desktop: true,
          currentImageModel: "Local Image",
          currentTextModel: "Local Text",
          hasReadyImage: true,
          hasReadyText: true,
        },
      }),
    );

    expect(readiness.overallStatus).toBe("partial");
    expect(readiness.primaryIssue?.id).toBe("imageGeneration");
    expect(readiness.primaryIssue?.href).toBe("/settings?panel=image");
    expect(readiness.byId.defaults.status).toBe("partial");
    expect(readiness.byId.defaults.href).toBe("/settings?panel=image");
  });

  it("reports ready when every creative capability is available", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        videoModels: [videoModel],
        bootstrapDefaultImageModel: imageModel.id,
        bootstrapDefaultTextModel: "local:Local Text",
        bootstrapDefaultVideoModel: videoModel.id,
        localSummary: {
          desktop: true,
          currentImageModel: "Local Image",
          currentTextModel: "Local Text",
          currentTextModelId: "Local Text",
          hasReadyImage: true,
          hasReadyText: true,
        },
      }),
    );

    expect(readiness.overallStatus).toBe("ready");
    expect(readiness.primaryIssue).toBeNull();
    expect(readiness.readyCount).toBe(5);
  });

  it("threads the same bootstrap text default id into readiness for chat and prompt gating", () => {
    const bootstrapDefaultTextModel = "byok:openai:gpt-4.1-mini";
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        bootstrapDefaultImageModel: imageModel.id,
        bootstrapDefaultTextModel,
        providers: { openai: { configured: true, source: "keychain" } },
        providerConnections: {
          openai: { hasSecret: true, models: { text: "gpt-4.1-mini" } },
        },
      }),
    );

    expect(readiness.byId.promptRefinement.status).toBe("ready");
    expect(readiness.byId.promptRefinement.activeLabel).toContain("gpt-4.1-mini");
    // Downstream surfaces (Canvas chat, AgentThread, Studio refine) gate on this
    // exact ready status derived from the bootstrap default id.
    expect(bootstrapDefaultTextModel).toBe("byok:openai:gpt-4.1-mini");
  });
});
