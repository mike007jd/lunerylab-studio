import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StudioComposer, type StudioComposerProps } from "@/components/studio/studio-composer";
import { I18nProvider } from "@/lib/i18n/provider";
import en from "@/lib/i18n/messages/en";
import zhCN from "@/lib/i18n/messages/zh-CN";
import zhTW from "@/lib/i18n/messages/zh-TW";

function buildProps(): StudioComposerProps {
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
      hasImageModels: false,
      onImageModelChange: () => {},
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
      isZh: false,
      generationParameters: {},
      onGenerationParametersChange: () => {},
      labels: {
        options: "Options",
        model: "Model",
        output: "Output",
        project: "Project",
        imageModel: "Image Model",
        noBackend: "No model",
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
  };
}

function renderComposer(locale: "en" | "zh-CN" | "zh-TW") {
  const messages = locale === "en" ? en : locale === "zh-CN" ? zhCN : zhTW;
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale} initialMessages={messages}>
      <StudioComposer {...buildProps()} />
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
