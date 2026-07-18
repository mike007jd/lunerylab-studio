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

function baseInput(overrides: Partial<CreativeCapabilityReadinessInput> = {}): CreativeCapabilityReadinessInput {
  return {
    imageModels: [],
    videoModels: [],
    catalogLoading: false,
    bootstrapDefaultImageModel: "",
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

  it("marks text refinement ready when a configured provider has a text model slot", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        providers: { anthropic: { configured: true, source: "keychain" } },
        providerConnections: {
          anthropic: { hasSecret: true, models: { text: "claude-sonnet-4-6" } },
        },
      }),
    );

    expect(readiness.byId.promptRefinement.status).toBe("ready");
    expect(readiness.byId.promptRefinement.activeLabel).toContain("claude-sonnet-4-6");
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
        localSummary: {
          desktop: true,
          currentImageModel: "Local Image",
          currentTextModel: "Local Text",
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
    expect(readiness.byId.videoGeneration.href).toBe("/settings?panel=provider-connections");
    expect(readiness.byId.videoGeneration.actionLabel).toBe(
      "capabilityReadiness.actions.connectVideoProvider",
    );
  });

  it("treats one available image model as selected even without a saved default", () => {
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

    expect(readiness.overallStatus).toBe("ready");
    expect(readiness.primaryIssue).toBeNull();
    expect(readiness.byId.defaults.status).toBe("ready");
    expect(readiness.byId.defaults.activeLabel).toBe("Local Image");
  });

  it("prioritizes task model selection before optional video provider setup when several models are available", () => {
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
    expect(readiness.primaryIssue?.id).toBe("defaults");
    expect(readiness.primaryIssue?.href).toBe("/settings?panel=general");
  });

  it("reports ready when every creative capability is available", () => {
    const readiness = deriveCreativeCapabilityReadiness(
      baseInput({
        imageModels: [imageModel],
        videoModels: [videoModel],
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

    expect(readiness.overallStatus).toBe("ready");
    expect(readiness.primaryIssue).toBeNull();
    expect(readiness.readyCount).toBe(5);
  });
});
