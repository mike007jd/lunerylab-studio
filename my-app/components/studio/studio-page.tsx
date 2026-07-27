"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getPresetsByCategory,
  findPresetById,
  type StylePreset,
  type StylePresetId,
  type PresetCategory,
} from "@/lib/presets/style-presets";
import {
  resolveSelectableImageModelId,
  resolveSelectableVideoModelId,
  useModelCatalog,
} from "@/lib/client/use-model-catalog";
import { useT } from "@/lib/i18n/useT";
import { useI18n } from "@/lib/i18n/provider";
import { isChineseLocale } from "@/lib/i18n/locale";
import { useSharedBootstrapSnapshot } from "@/lib/client/bootstrap-snapshot-provider";
import { useTemporaryMessage } from "@/hooks/use-temporary-message";
import { useStudioReferenceFiles } from "@/components/studio/hooks/use-studio-reference-files";
import { useVideoGenerationController } from "@/components/studio/hooks/use-video-generation";
import { useImageGenerationController } from "@/components/studio/hooks/use-image-generation-controller";
import { useStudioGenerationActions } from "@/components/studio/hooks/use-studio-generation-actions";
import { useStudioProjectTarget } from "@/components/studio/hooks/use-studio-project-target";
import { useStudioPromptOptimization } from "@/components/studio/hooks/use-studio-prompt-optimization";
import { useGenerationActivityRegistry } from "@/components/studio/controllers/generation-activity-registry";

import {
  type ProjectOption,
  MAX_REFERENCE_FILES,
} from "@/components/studio/studio-constants";
import { StudioGenerationSurface } from "@/components/studio/studio-generation-surface";
import { ProjectNameDialog } from "@/components/projects/project-name-dialog";
import { useStudioGenerationHistory } from "@/components/studio/use-studio-generation-history";
import { useCreativeCapabilityReadiness } from "@/hooks/use-creative-capability-readiness";
import type { GenerationParameters } from "@/lib/generation-parameters";
import {
  filterGenerationParametersToCapabilities,
  resolveImageAdvancedParameters,
} from "@/lib/image-models";

interface StudioPageProps {
  initialProjects: ProjectOption[];
  initialBootstrap?: import("@/lib/client/use-bootstrap-snapshot").BootstrapSnapshot;
}

export function StudioPage({
  initialProjects,
  initialBootstrap,
}: StudioPageProps) {
  const t = useT();
  const { locale } = useI18n();
  const isZh = isChineseLocale(locale);
  const router = useRouter();
  const searchParams = useSearchParams();
  const bootstrapSnapshot = useSharedBootstrapSnapshot() ?? initialBootstrap;
  const { imageModels, videoModels, defaultImageModelId } = useModelCatalog();
  const readiness = useCreativeCapabilityReadiness();
  const hasImageModels = imageModels.length > 0;
  const hasVideoModels = videoModels.length > 0;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [activePresetCategory, setActivePresetCategory] = useState<PresetCategory>(
    () => findPresetById(searchParams.get("preset"))?.category ?? "photography"
  );
  const filteredPresets = useMemo(() => getPresetsByCategory(activePresetCategory), [activePresetCategory]);
  const [selectedPresetId, setSelectedPresetId] = useState<StylePresetId | "">(
    () => findPresetById(searchParams.get("preset"))?.id ?? ""
  );
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [prompt, setPrompt] = useState(() => searchParams.get("prompt") ?? "");
  const [imageRunMode, setImageRunMode] = useState<"single" | "batch">("single");
  const [aspectRatio, setAspectRatio] = useState<string>(
    () => findPresetById(searchParams.get("preset"))?.defaults?.aspectRatio ?? "1:1"
  );
  const [generationParameters, setGenerationParameters] = useState<GenerationParameters>({});
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // Local-first default: prefer the user's pick, then the snapshot, then the
  // catalog's local→BYOK→cloud effective default. There is NO hardcoded
  // fallback — when nothing is configured this resolves to "" and the UI blocks
  // generation with a "pick or connect a model" hint instead of silently
  // routing to a model the user never chose.
  const activeImageModelId = resolveSelectableImageModelId(
    imageModels,
    selectedModel ?? bootstrapSnapshot?.app.defaultImageModel ?? defaultImageModelId,
    defaultImageModelId,
  );
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const projectTarget = useStudioProjectTarget({
    initialProjects,
    sampleId: searchParams.get("sample"),
    t,
    setNotice,
  });
  const {
    projectId,
    options: uniqueProjects,
    activeProjectName,
    isCreating: isCreatingProject,
  } = projectTarget;
  const [generationMode, setGenerationMode] = useState<"image" | "video">("image");
  // No default video model — empty stays empty until the user picks a video
  // model from the composer or connects a BYOK video provider in Settings.
  const [videoModelId, setVideoModelId] = useState<string>(
    bootstrapSnapshot?.app.defaultVideoModel ?? "",
  );
  const [videoDuration, setVideoDuration] = useState(6);
  const {
    files,
    filePreviews,
    draggingPreviewKey,
    dragOverPreviewKey,
    handleFileChange,
    handleRemoveFile,
    handleMoveFile,
    handlePreviewDragStart,
    handlePreviewDragEnd,
    handlePreviewDragOver,
    handlePreviewDragLeave,
    handleDropOnPreview,
    uploadReferenceAssets,
    consumePendingReference,
  } = useStudioReferenceFiles(MAX_REFERENCE_FILES);
  const hasVideoReference = files.length > 0;
  const selectedVideoModelId = resolveSelectableVideoModelId(
    videoModels,
    videoModelId,
    { hasReferenceImage: hasVideoReference },
  );
  const selectedVideoModel = useMemo(
    () => videoModels.find(
      (model) => model.id === selectedVideoModelId || model.providerModelId === selectedVideoModelId,
    ),
    [selectedVideoModelId, videoModels],
  );
  const hasUsableVideoModel = Boolean(
    selectedVideoModel && (hasVideoReference || !selectedVideoModel.requiresImageInput),
  );

  const selectedPreset = useMemo(() => findPresetById(selectedPresetId || null), [selectedPresetId]);
  const batchVariants = imageRunMode === "batch" ? selectedPreset?.batchVariants : undefined;
  const imageOutputCount = imageRunMode === "single" ? 1 : batchVariants?.length ?? 4;
  const modeHasBackend = generationMode === "image" ? hasImageModels : hasVideoModels;
  const modeCanGenerate = generationMode === "image" ? Boolean(activeImageModelId) : hasUsableVideoModel;
  const videoNeedsReference = generationMode === "video" && hasVideoModels && !modeCanGenerate && !hasVideoReference;
  const canRefinePrompt = readiness.byId.promptRefinement.status === "ready" && (modeCanGenerate || videoNeedsReference);
  const modeReadiness = generationMode === "image"
    ? readiness.byId.imageGeneration
    : readiness.byId.videoGeneration;
  const disabledGenerateReason = videoNeedsReference
    ? t("studio.batchRequiresRef")
    : !modeCanGenerate
      ? generationMode === "image" && hasImageModels
        ? readiness.byId.defaults.reason ?? readiness.byId.defaults.detail
        : modeReadiness.reason ?? modeReadiness.detail
      : undefined;
  const disabledRefineReason = !canRefinePrompt
    ? readiness.byId.promptRefinement.reason ?? readiness.byId.promptRefinement.detail
    : undefined;
  const composerPlaceholder = t(
    generationMode === "video" ? "studio.videoComposerPlaceholder" : "studio.composerPlaceholder",
  );
  const promptOptimization = useStudioPromptOptimization({
    canRefinePrompt,
    prompt,
    selectedPreset,
    referenceCount: files.length,
    locale,
    generationMode,
    videoModels,
    selectedVideoModelId,
    videoDuration,
    isZh,
    t,
    setPrompt,
    setError,
    setNotice,
  });

  const history = useStudioGenerationHistory();
  const generationActivity = useGenerationActivityRegistry();
  const imageGeneration = useImageGenerationController({
    registry: generationActivity.registry,
    history,
    imageModels,
    t,
  });
  const videoGeneration = useVideoGenerationController({
    registry: generationActivity.registry,
    history,
    t,
  });
  const isGenerating = generationActivity.anyGenerationActive;
  const hasResults = history.entries.length > 0;

  const optionsLabels = useMemo(
    () => ({
      options: t("studio.options"),
      model: t("studio.model"),
      output: t("studio.output"),
      project: t("studio.projectLabel"),
      imageModel: t("canvas.imageModel"),
      noBackend: t("studio.taskIntents.noBackend"),
      aspectRatio: t("studio.aspectRatio"),
      variants: t("studio.variants"),
      selectProject: t("studio.selectProject"),
      noProjects: t("studio.noProjects"),
      newProject: t("studio.newProject"),
      advanced: t("studio.advanced"),
      seed: t("studio.seed"),
      seedRandom: t("studio.seedRandom"),
      steps: t("studio.steps"),
      cfg: t("studio.cfg"),
      automatic: t("studio.automatic"),
      negativePrompt: t("studio.negativePrompt"),
    }),
    [t],
  );

  useTemporaryMessage(notice, () => setNotice(""), 1800);

  useEffect(() => {
    const controller = new AbortController();
    void consumePendingReference(controller.signal).then((result) => {
      if (result === true) setNotice(t("studio.libraryTabs.useAsReferenceSent"));
      if (result === false) setError(t("studio.libraryTabs.useAsReferenceFailed"));
    });
    return () => controller.abort();
    // Intentionally run once per studio mount; t identity changes on locale flip
    // are tolerable since the key has already been consumed by then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleImageModelChange = useCallback((modelId: string) => {
    setSelectedModel(modelId);
    const selected = imageModels.find(
      (model) => model.id === modelId || model.providerModelId === modelId,
    );
    // Drop advanced fields the newly selected model cannot honor so the UI and
    // the next request fingerprint stay aligned with provider capabilities.
    setGenerationParameters((previous) =>
      filterGenerationParametersToCapabilities(
        previous,
        resolveImageAdvancedParameters(selected),
      ),
    );
  }, [imageModels]);

  const handleOpenFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFocusPrompt = useCallback(() => textareaRef.current?.focus(), []);
  const handleNavigate = useCallback((href: string) => router.push(href), [router]);

  const handleSelectPreset = useCallback((preset: StylePreset) => {
    setSelectedPresetId(preset.id);
    setPresetPickerOpen(false);
    if (preset.defaults?.aspectRatio) setAspectRatio(preset.defaults.aspectRatio);
    setNotice(t("studio.styleSelected", { name: isZh ? preset.nameZh : preset.name }));
    setError("");
  }, [isZh, t]);

  const handleClearPresetSelection = useCallback(() => {
    setSelectedPresetId("");
    setPresetPickerOpen(false);
  }, []);

  const generationActions = useStudioGenerationActions({
    history,
    imageGeneration,
    videoGeneration,
    generationMode,
    prompt,
    selectedVideoModel,
    selectedVideoModelId,
    videoDuration,
    aspectRatio,
    projectId,
    selectedPreset,
    files,
    uploadReferenceAssets,
    imageRunMode,
    activeImageModelId,
    imageOutputCount,
    batchVariants,
    generationParameters,
    imageModels,
    setGenerationParameters,
    onCreateProject: projectTarget.openCreateDialog,
    onFocusPrompt: handleFocusPrompt,
    navigate: handleNavigate,
    t,
    setError,
    setNotice,
  });

  return (
    <>
      <StudioGenerationSurface
        hydrated={history.hydrated}
        hasResults={hasResults}
        readiness={readiness}
        focusId={generationMode === "image" ? "imageGeneration" : "videoGeneration"}
        composerProps={{
          fileInputRef,
          textareaRef,
          onFileChange: handleFileChange,
          referenceDeckProps: {
            filePreviews,
            draggingPreviewKey,
            dragOverPreviewKey,
            onOpenFilePicker: handleOpenFilePicker,
            onRemoveFile: handleRemoveFile,
            onMoveFile: handleMoveFile,
            onDragStart: handlePreviewDragStart,
            onDragEnd: handlePreviewDragEnd,
            onDragOver: handlePreviewDragOver,
            onDragLeave: handlePreviewDragLeave,
            onDrop: handleDropOnPreview,
            removeLabel: t("studio.removeReference"),
            addLabel: t("studio.addReference"),
            moveBeforeLabel: t("studio.moveReferenceBefore"),
            moveAfterLabel: t("studio.moveReferenceAfter"),
          },
          prompt,
          onPromptChange: setPrompt,
          onPromptKeyDown: generationActions.onPromptKeyDown,
          placeholder: composerPlaceholder,
          mode: generationMode,
          onModeChange: setGenerationMode,
          imageRunMode,
          onImageRunModeChange: setImageRunMode,
          presetPickerProps: {
            open: presetPickerOpen,
            onOpenChange: setPresetPickerOpen,
            activeCategory: activePresetCategory,
            onCategoryChange: setActivePresetCategory,
            filteredPresets,
            selectedPresetId,
            selectedPreset,
            onSelectPreset: handleSelectPreset,
            onClearSelection: handleClearPresetSelection,
            isZh,
            stylePresetLabel: t("studio.stylePreset"),
            clearSelectionLabel: t("studio.clearSelection"),
          },
          optionsProps: {
            mode: generationMode,
            imageModels,
            activeImageModelId,
            hasImageModels,
            onImageModelChange: handleImageModelChange,
            aspectRatio,
            onAspectRatioChange: setAspectRatio,
            candidateCount: imageOutputCount,
            selectedPreset,
            videoModels,
            selectedVideoModelId,
            videoDuration,
            onVideoModelChange: setVideoModelId,
            onVideoDurationChange: setVideoDuration,
            hasVideoReference,
            projectId,
            projects: uniqueProjects,
            onProjectChange: projectTarget.changeProject,
            onCreateProject: projectTarget.openCreateDialog,
            isCreatingProject,
            isZh,
            generationParameters,
            onGenerationParametersChange: setGenerationParameters,
            labels: optionsLabels,
          },
          activeProjectName,
          referenceCount: files.length,
          canRefinePrompt,
          onRefinePrompt: () => void promptOptimization.optimize(),
          isOptimizing: promptOptimization.isOptimizing,
          isGenerating,
          disabledRefineReason,
          refineAction:
            readiness.byId.promptRefinement.href &&
            readiness.byId.promptRefinement.actionLabel
              ? {
                  href: readiness.byId.promptRefinement.href,
                  label: readiness.byId.promptRefinement.actionLabel,
                }
              : undefined,
          onOpenRefineAction: router.push,
          modeCanGenerate,
          modeHasBackend,
          modeUnavailableReason: modeReadiness.reason ?? modeReadiness.detail,
          videoNeedsReference,
          disabledGenerateReason,
          onGenerate: () => void generationActions.generate(),
          imageOutputCount,
          notice,
          error,
        }}
        resultsProps={{
          entries: history.entries,
          progressByEntry: imageGeneration.progressByEntry,
          isEntryBusy: generationActivity.isEntryGenerating,
          onRegenerate: generationActions.regenerate,
          onSendToCanvas: generationActions.sendToCanvas,
          onDismiss: generationActions.dismiss,
          onCancel: generationActions.cancel,
          onReuseParameters: generationActions.reuseParameters,
        }}
      />
      <ProjectNameDialog
        open={projectTarget.dialog.open}
        name={projectTarget.dialog.name}
        title={t("studio.newProject")}
        description={t("library.projectNameDescription")}
        inputLabel={t("agent.projectName")}
        submitLabel={t("studio.newProject")}
        cancelLabel={t("common.cancel")}
        pending={isCreatingProject}
        error={projectTarget.dialog.error}
        onNameChange={projectTarget.dialog.setName}
        onOpenChange={projectTarget.dialog.setOpen}
        onSubmit={projectTarget.dialog.submit}
      />
    </>
  );
}
