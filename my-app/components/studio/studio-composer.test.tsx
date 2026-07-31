import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StudioComposer, type StudioComposerProps } from "@/components/studio/studio-composer";
import { I18nProvider } from "@/lib/i18n/provider";
import type { ImageModelEntry } from "@/lib/image-models";
import en from "@/lib/i18n/messages/en";
import zhCN from "@/lib/i18n/messages/zh-CN";
import zhTW from "@/lib/i18n/messages/zh-TW";

const localImageModel: ImageModelEntry = {
  id: "flux1-schnell-q4",
  providerModelId: "flux1-schnell-q4",
  apiMode: "image",
  brand: "Local",
  brandZh: "本地",
  label: "FLUX Schnell",
  labelZh: "FLUX Schnell",
  tier: "standard",
  supportsEdit: false,
  supportsAspectRatio: true,
  source: "local",
};

const byokImageModel: ImageModelEntry = {
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

function buildProps(overrides: Partial<StudioComposerProps> = {}): StudioComposerProps {
  return {
    fileInputRef: { current: null },
    textareaRef: { current: null },
    onFileChange: () => {},
    referenceDeckProps: {
      filePreviews: [],
      draggingPreviewKey: null,
      dragOverPreviewKey: null,
      onOpenFilePicker: () => {},
      onRemoveFile: () => {},
      onMoveFile: () => {},
      onDragStart: () => {},
      onDragEnd: () => {},
      onDragOver: () => {},
      onDragLeave: () => {},
      onDrop: () => {},
      removeLabel: "Remove",
      addLabel: "Add",
      moveBeforeLabel: "Before",
      moveAfterLabel: "After",
    },
    prompt: "",
    onPromptChange: () => {},
    onPromptKeyDown: () => {},
    placeholder: "Describe the image...",
    mode: "image",
    onModeChange: () => {},
    imageRunMode: "single",
    onImageRunModeChange: () => {},
    imageModelPicker: {
      models: [],
      value: "",
      onChange: () => {},
      isZh: false,
      label: "Image Model",
      placeholder: "Pick image model",
      noModelsLabel: "No model connected.",
    },
    presetPickerProps: {
      open: false,
      onOpenChange: () => {},
      activeCategory: "photography",
      onCategoryChange: () => {},
      filteredPresets: [],
      selectedPresetId: "",
      selectedPreset: null,
      onSelectPreset: () => {},
      onClearSelection: () => {},
      isZh: false,
      stylePresetLabel: "Style",
      clearSelectionLabel: "Clear",
    },
    optionsProps: {
      mode: "image",
      imageModels: [],
      activeImageModelId: "",
      aspectRatio: "1:1",
      onAspectRatioChange: () => {},
      candidateCount: 1,
      selectedPreset: null,
      videoModels: [],
      selectedVideoModelId: "",
      videoDuration: 6,
      onVideoModelChange: () => {},
      onVideoDurationChange: () => {},
      hasVideoReference: false,
      projectId: "",
      projects: [],
      onProjectChange: () => {},
      onCreateProject: () => {},
      isCreatingProject: false,
      generationParameters: {},
      onGenerationParametersChange: () => {},
      labels: {
        options: "Options",
        model: "Model",
        output: "Output",
        project: "Project",
        aspectRatio: "Aspect Ratio",
        variants: "variants",
        selectProject: "Select project",
        noProjects: "No projects",
        newProject: "New project",
        advanced: "Advanced",
        seed: "Seed",
        seedRandom: "Random",
        steps: "Steps",
        cfg: "CFG",
        automatic: "Auto",
        negativePrompt: "Negative prompt",
      },
    },
    referenceCount: 0,
    canRefinePrompt: false,
    onRefinePrompt: () => {},
    isOptimizing: false,
    isGenerating: false,
    onOpenRefineAction: () => {},
    modeCanGenerate: true,
    modeHasBackend: true,
    videoNeedsReference: false,
    onGenerate: vi.fn(),
    imageOutputCount: 1,
    notice: "",
    error: "",
    ...overrides,
  };
}

function renderComposer(
  locale: "en" | "zh-CN" | "zh-TW",
  overrides: Partial<StudioComposerProps> = {},
) {
  const messages = locale === "en" ? en : locale === "zh-CN" ? zhCN : zhTW;
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale} initialMessages={messages}>
      <StudioComposer {...buildProps(overrides)} />
    </I18nProvider>,
  );
}

describe("StudioComposer prompt naming", () => {
  it("gives the primary prompt textarea the localized promptLabel accessible name", () => {
    expect(renderComposer("en")).toContain(`aria-label="${en.studio.promptLabel}"`);
    expect(renderComposer("zh-CN")).toContain(`aria-label="${zhCN.studio.promptLabel}"`);
    expect(renderComposer("zh-TW")).toContain(`aria-label="${zhTW.studio.promptLabel}"`);
  });
});

describe("StudioComposer image model picker", () => {
  const pickerWithModels = {
    models: [localImageModel, byokImageModel],
    value: "",
    onChange: () => {},
    isZh: false,
    label: "Image Model",
    placeholder: "Pick image model",
    noModelsLabel: "No model connected.",
  };

  it("exposes exactly one labeled image-model selector in image mode", () => {
    const markup = renderComposer("en", { imageModelPicker: { ...pickerWithModels } });
    expect(markup.match(/aria-label="Image Model"/g)).toHaveLength(1);
  });

  it("prompts for an explicit pick when models exist but none is selected", () => {
    const markup = renderComposer("en", { imageModelPicker: { ...pickerWithModels } });
    expect(markup).toContain("Pick image model");
  });

  it("shows the current session selection on the trigger", () => {
    const markup = renderComposer("en", {
      imageModelPicker: { ...pickerWithModels, value: "flux1-schnell-q4" },
    });
    expect(markup).toContain("FLUX Schnell");
    expect(markup).not.toContain("Pick image model");
  });

  it("renders a disabled no-backend state when no image model is available", () => {
    const markup = renderComposer("en");
    expect(markup).toContain("No model connected.");
    expect(markup).not.toContain("Pick image model");
  });

  it("hides the image model picker in video mode", () => {
    const base = buildProps();
    const markup = renderComposer("en", {
      mode: "video",
      imageModelPicker: { ...pickerWithModels },
      optionsProps: { ...base.optionsProps, mode: "video" },
    });
    expect(markup).not.toContain('aria-label="Image Model"');
  });

  it("keeps the Options trigger free of any model summary in image mode", () => {
    const markup = renderComposer("en", { imageModelPicker: { ...pickerWithModels } });
    expect(markup.match(/aria-label="Options:/g)).toHaveLength(1);
    expect(markup).not.toContain("FLUX Schnell");
  });
});
