"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Send, Wand2 } from "@/components/ui/icons";
import {
  getPresetsByCategory,
  findPresetById,
  type StylePreset,
  type StylePresetId,
  type PresetCategory,
} from "@/lib/presets/style-presets";
import { fetchJson, toErrorMessage } from "@/lib/client/fetch-json";
import { sendAssetToCanvas } from "@/lib/client/canvas-sessions";
import { addCanvasEntrySource } from "@/lib/client/creation-flow";
import {
  createKeyedSingleFlight,
  resolveImageGenerationOutcome,
  type ImageGenerationOutcome,
} from "@/lib/client/generation-presentation";
import { announceProjectCreated } from "@/lib/client/project-created-event";
import {
  createPreparingProgress,
  isRequestAbortedError,
  pollSdProgress,
  requestSdCancellation,
} from "@/lib/client/sd-progress";
import {
  resolveSelectableImageModelId,
  resolveSelectableVideoModelId,
  useModelCatalog,
} from "@/lib/client/use-model-catalog";
import {
  optimizeStudioPrompt,
  validateStudioPromptOptimizeInput,
} from "@/lib/client/studio-prompt-optimizer";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/useT";
import { useI18n } from "@/lib/i18n/provider";
import { isChineseLocale } from "@/lib/i18n/locale";
import { useSharedBootstrapSnapshot } from "@/lib/client/bootstrap-snapshot-provider";
import { useActiveProject } from "@/lib/client/active-project-provider";
import { useTemporaryMessage } from "@/hooks/use-temporary-message";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useStudioReferenceFiles } from "@/components/studio/hooks/use-studio-reference-files";
import { useVideoGeneration } from "@/components/studio/hooks/use-video-generation";

import {
  type ProjectOption,
  DEFAULT_SCENE_MODE,
  MAX_REFERENCE_FILES,
  COMPOSER_DECK_LAYOUT_CLASS,
  COMPOSER_TEXTAREA_OFFSET_CLASS,
} from "@/components/studio/studio-constants";
import { ComposerDeck } from "@/components/studio/studio-composer-deck";
import { PresetPicker } from "@/components/studio/studio-preset-picker";
import { StudioCapabilityBanner } from "@/components/studio/studio-capability-banner";
import { GenerationResultsGrid } from "@/components/studio/generation-results-grid";
import { StudioOptionsPopover } from "@/components/studio/studio-options-popover";
import { ProjectNameDialog } from "@/components/projects/project-name-dialog";
import { PageReveal } from "@/components/motion/motion-primitives";
import { useStudioGenerationHistory } from "@/components/studio/use-studio-generation-history";
import { useCreativeCapabilityReadiness } from "@/hooks/use-creative-capability-readiness";
import type { AssetDTO, GenerationResponse } from "@/lib/types/api";
import type { SdProgress } from "@/lib/types/sd-progress";
import {
  dedupeProjectOptions,
  resolveInitialSampleId,
} from "@/components/studio/studio-project-options";
import { buildDefaultProjectName } from "@/lib/project-name";
import { createProject as createProjectRequest } from "@/lib/client/projects";
import type { GenerationParameters } from "@/lib/generation-parameters";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveGenerationPrompt({
  prompt,
  selectedPreset,
}: {
  prompt: string;
  selectedPreset: StylePreset | null;
}): { activePreset: StylePreset | null; workingPrompt: string } {
  const workingPrompt = prompt.trim() || (selectedPreset ? selectedPreset.promptGuidance : "");
  return { activePreset: selectedPreset, workingPrompt };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

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
  // Synchronous re-entry guard for handleGenerate: set once a submit starts and
  // cleared in finally, so a same-frame double Cmd+Enter can't double-charge BYOK.
  const isSubmittingRef = useRef(false);
  const imageRequestControlsRef = useRef(
    new Map<
      string,
      {
        runId: string;
        requestController: AbortController;
        pollController: AbortController;
        cancelRequested: boolean;
      }
    >(),
  );
  const [sdProgressByEntry, setSdProgressByEntry] = useState<
    Record<string, SdProgress | undefined>
  >({});
  const [regenerateSingleFlight] = useState(createKeyedSingleFlight);
  const [projectCreateSingleFlight] = useState(createKeyedSingleFlight);

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
  const { activeProjectId, setActiveProject } = useActiveProject();
  const [projects, setProjects] = useState<ProjectOption[]>(initialProjects);
  // The working project is the persisted active project (set here, in the
  // sidebar New-Project flow, or by opening a project workspace), falling back to
  // the URL sample hint or the first project. Generation lands in this project;
  // a stale (deleted) active id falls back rather than targeting a missing project.
  const projectId =
    activeProjectId && projects.some((project) => project.id === activeProjectId)
      ? activeProjectId
      : resolveInitialSampleId(searchParams.get("sample"), initialProjects);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [projectNameDialogOpen, setProjectNameDialogOpen] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [projectNameError, setProjectNameError] = useState("");
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationMode, setGenerationMode] = useState<"image" | "video">("image");
  // No default video model — empty stays empty until the user picks a video
  // model from the composer or connects a BYOK video provider in Settings.
  const [videoModelId, setVideoModelId] = useState<string>(
    bootstrapSnapshot?.app.defaultVideoModel ?? "",
  );
  const [videoDuration, setVideoDuration] = useState(6);
  const videoGen = useVideoGeneration();
  const [activeVideoEntryId, setActiveVideoEntryId] = useState<string | null>(null);
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
  const uniqueProjects = useMemo(() => dedupeProjectOptions(projects), [projects]);
  const activeProjectName = uniqueProjects.find((project) => project.id === projectId)?.name;
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

  const history = useStudioGenerationHistory();
  const hasResults = history.entries.length > 0;

  // Only surface the keyboard shortcut once generation is available.
  const shortcutHint = t("studio.shortcutHint");

  const refinePromptLabel = t("studio.refinePrompt");

  // Keep popover props stable while the user types in the composer.
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

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  useTemporaryMessage(notice, () => setNotice(""), 1800);

  useEffect(() => {
    if (!activeVideoEntryId) return;

    if (videoGen.status === "succeeded") {
      history.update(activeVideoEntryId, {
        status: videoGen.asset ? "succeeded" : "failed",
        assets: videoGen.asset ? [videoGen.asset] : [],
        error: videoGen.asset ? null : t("studio.videoFailed"),
      });
      queueMicrotask(() => setActiveVideoEntryId(null));
    }

    if (videoGen.status === "failed") {
      history.update(activeVideoEntryId, {
        status: "failed",
        error: videoGen.error ?? t("studio.videoFailed"),
      });
      queueMicrotask(() => setActiveVideoEntryId(null));
    }
  }, [activeVideoEntryId, history, t, videoGen.asset, videoGen.error, videoGen.status]);

  // Library "Use as reference" handshake — drains the sessionStorage key and
  // materialises the asset as a reference File. All the fetch/File logic lives
  // in `useStudioReferenceFiles.consumePendingReference`.
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

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleOpenFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const createProject = useCallback(async (name: string): Promise<ProjectOption> => {
    return createProjectRequest({ name });
  }, []);

  const addProjectToState = useCallback((project: ProjectOption) => {
    setProjects((prev) => [project, ...prev.filter((item) => item.id !== project.id)]);
    setActiveProject(project.id);
    announceProjectCreated(project);
  }, [setActiveProject]);

  const handleCreateProject = useCallback(() => {
    setProjectNameDraft(buildDefaultProjectName(t));
    setProjectNameError("");
    setProjectNameDialogOpen(true);
  }, [t]);

  const handleProjectNameSubmit = useCallback(async (name: string) => {
    await projectCreateSingleFlight.run("create-project", async () => {
      setIsCreatingProject(true);
      setProjectNameError("");
      try {
        const createdProject = await createProject(name);
        addProjectToState(createdProject);
        setProjectNameDialogOpen(false);
        setNotice(t("studio.projectCreated", { name: createdProject.name }));
      } catch (createError) {
        setProjectNameError(toErrorMessage(createError, t("studio.createProjectFailed")));
      } finally {
        setIsCreatingProject(false);
      }
    });
  }, [addProjectToState, createProject, projectCreateSingleFlight, t]);

  // Preserve memoization while following the latest locale-bound handler.
  const handleCreateProjectVoid = useCallback(
    () => handleCreateProject(),
    [handleCreateProject],
  );

  const handleProjectChange = useCallback((nextProjectId: string) => {
    setActiveProject(nextProjectId);
  }, [setActiveProject]);

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

  const handleOptimizePrompt = useCallback(async () => {
    setError("");
    const validationKey = validateStudioPromptOptimizeInput({
      canRefinePrompt,
      prompt,
      hasSelectedPreset: Boolean(selectedPreset),
    });
    if (validationKey) {
      setError(t(validationKey));
      return;
    }
    try {
      setIsOptimizing(true);

      const result = await optimizeStudioPrompt({
        prompt,
        mode: DEFAULT_SCENE_MODE,
        referenceCount: files.length,
        locale,
        generationType: generationMode,
        videoModels,
        selectedVideoModelId,
        videoDuration,
        presetName: selectedPreset ? (isZh ? selectedPreset.nameZh : selectedPreset.name) : undefined,
        presetGuidance: selectedPreset?.promptGuidance,
      });
      setPrompt(result.optimizedPrompt);
      setNotice(t(result.noticeKey));
    } catch (optimizeError) {
      setError(toErrorMessage(optimizeError, t("studio.optimizeFailed")));
    } finally {
      setIsOptimizing(false);
    }
  }, [
    prompt,
    selectedPreset,
    t,
    canRefinePrompt,
    generationMode,
    selectedVideoModelId,
    videoModels,
    videoDuration,
    files.length,
    locale,
    isZh,
  ]);

  // Image generation stays on the direct endpoint; Canvas/agent edits remain
  // separate flows.
  const runImageGenerationRequest = useCallback(
    async (params: {
      entryId: string;
      prompt: string;
      modelId: string;
      aspectRatio: string;
      count: number;
      presetId: string | null;
      projectId: string | null;
      referenceAssetIds: string[];
      uploadedFiles: File[];
      generationParameters: GenerationParameters;
    }): Promise<ImageGenerationOutcome> => {
      const previous = imageRequestControlsRef.current.get(params.entryId);
      if (previous) {
        previous.cancelRequested = true;
        await requestSdCancellation(previous.runId);
        previous.requestController.abort();
        previous.pollController.abort();
      }
      const runId = crypto.randomUUID();
      const requestController = new AbortController();
      const pollController = new AbortController();
      imageRequestControlsRef.current.set(params.entryId, {
        runId,
        requestController,
        pollController,
        cancelRequested: false,
      });
      setSdProgressByEntry((current) => ({
        ...current,
        [params.entryId]: createPreparingProgress(runId, params.count),
      }));
      void pollSdProgress({
        runId,
        signal: pollController.signal,
        onProgress: (progress) => {
          if (imageRequestControlsRef.current.get(params.entryId)?.runId !== runId) return;
          setSdProgressByEntry((current) => ({ ...current, [params.entryId]: progress }));
        },
      });

      const form = new FormData();
      form.append("runId", runId);
      form.append("prompt", params.prompt);
      form.append("count", String(params.count));
      form.append("aspectRatio", params.aspectRatio);
      form.append("modelId", params.modelId);
      if (params.generationParameters.seed !== undefined) form.append("seed", String(params.generationParameters.seed));
      if (params.generationParameters.steps !== undefined) form.append("steps", String(params.generationParameters.steps));
      if (params.generationParameters.cfg !== undefined) form.append("cfg", String(params.generationParameters.cfg));
      if (params.generationParameters.negativePrompt) form.append("negativePrompt", params.generationParameters.negativePrompt);
      if (params.projectId) form.append("projectId", params.projectId);
      if (params.presetId) form.append("presetId", params.presetId);
      for (const id of params.referenceAssetIds) {
        form.append("referenceAssetIds", id);
      }
      for (const file of params.uploadedFiles) {
        form.append("files", file);
      }
      form.append("idempotencyKey", crypto.randomUUID());

      try {
        const data = await fetchJson<GenerationResponse>("/api/generate/images", {
          method: "POST",
          body: form,
          signal: requestController.signal,
        });

        const outcome = resolveImageGenerationOutcome(data, t("studio.generationFailed"));
        const firstAsset = outcome.assets[0];
        history.update(params.entryId, {
          status: outcome.status,
          assets: outcome.assets,
          warnings: outcome.warnings,
          error: outcome.error,
          generationParameters: {
            ...params.generationParameters,
            ...(firstAsset?.generationSeed == null ? {} : { seed: firstAsset.generationSeed }),
            ...(firstAsset?.generationSteps == null ? {} : { steps: firstAsset.generationSteps }),
            ...(firstAsset?.generationCfg == null ? {} : { cfg: firstAsset.generationCfg }),
            ...(firstAsset?.negativePrompt ? { negativePrompt: firstAsset.negativePrompt } : {}),
          },
        });
        return outcome;
      } finally {
        pollController.abort();
        if (imageRequestControlsRef.current.get(params.entryId)?.runId === runId) {
          imageRequestControlsRef.current.delete(params.entryId);
          setSdProgressByEntry((current) => {
            if (current[params.entryId]?.runId !== runId) return current;
            const next = { ...current };
            delete next[params.entryId];
            return next;
          });
        }
      }
    },
    [history, t],
  );

  const handleGenerate = useCallback(async () => {
    // Synchronous re-entry guard (H2): reject a second submit that arrives in
    // the same frame before React flips isGenerating. The ref is acquired below
    // once validation passes (before the first await) and released in finally.
    if (isSubmittingRef.current) return;
    setError("");

    // ── Video branch — fire-and-forget; the results grid is the single
    // canonical status surface. We don't redirect.
    if (generationMode === "video") {
      const workingPrompt = prompt.trim();
      if (!workingPrompt) {
        setError(t("studio.videoPromptRequired"));
        return;
      }
      if (!selectedVideoModel) {
        setError(t("studio.taskIntents.videoNoBackend"));
        return;
      }
      if (selectedVideoModel.requiresImageInput && files.length === 0) {
        setError(t("studio.batchRequiresRef"));
        return;
      }

      const entryId = history.add({
        mode: "video",
        prompt: workingPrompt,
        modelId: selectedVideoModelId,
        aspectRatio: aspectRatio,
        count: 1,
        presetId: selectedPreset?.id ?? null,
        projectId: projectId || null,
        referenceAssetIds: [],
        batchVariants: null,
        generationParameters: {},
      });
      setActiveVideoEntryId(entryId);

      try {
        isSubmittingRef.current = true;
        setIsGenerating(true);
        const referenceImage = files.length > 0 ? files[0] : undefined;
        const started = await videoGen.submit({
          prompt: workingPrompt,
          modelId: selectedVideoModelId,
          duration: videoDuration,
          projectId: projectId || undefined,
          referenceImage,
        });
        if (started) {
          setNotice(t("studio.videoStarted"));
        } else {
          history.update(entryId, { status: "failed", error: t("studio.videoFailed") });
          setActiveVideoEntryId(null);
          setError(t("studio.videoFailed"));
        }
      } catch (generateError) {
        const message = toErrorMessage(generateError, t("studio.videoFailed"));
        history.update(entryId, { status: "failed", error: message });
        setActiveVideoEntryId(null);
        setError(message);
      } finally {
        isSubmittingRef.current = false;
        setIsGenerating(false);
      }
      return;
    }

    // ── Image branch ──
    const { activePreset, workingPrompt } = resolveGenerationPrompt({ prompt, selectedPreset });

    if (!workingPrompt) {
      setError(t("studio.validation"));
      return;
    }

    if (imageRunMode === "batch" && activePreset?.batchVariants?.length && files.length === 0) {
      setError(t("studio.batchRequiresRef"));
      return;
    }

    if (!activeImageModelId) {
      setError(t("studio.taskIntents.noBackend"));
      return;
    }

    if (!projectId && files.length > 0) {
      handleCreateProject();
      return;
    }

    isSubmittingRef.current = true;
    setIsGenerating(true);
    let entryId: string | null = null;
    try {
      const effectiveProjectId = projectId;

      // Upload reference files first (if any) so we can record stable
      // referenceAssetIds in the history entry — that lets retry rebuild the
      // exact same request without re-uploading.
      const referenceAssetIds = effectiveProjectId
        ? await uploadReferenceAssets(effectiveProjectId)
        : [];

      entryId = history.add({
        mode: "image",
        prompt: workingPrompt,
        modelId: activeImageModelId,
        aspectRatio,
        count: imageOutputCount,
        presetId: activePreset?.id ?? null,
        projectId: effectiveProjectId || null,
        referenceAssetIds,
        batchVariants:
          batchVariants?.map((v) => ({
            key: v.key,
            label: v.label,
            promptSuffix: v.promptSuffix,
          })) ?? null,
        generationParameters,
      });

      const outcome = await runImageGenerationRequest({
        entryId,
        prompt: workingPrompt,
        modelId: activeImageModelId,
        aspectRatio,
        count: imageOutputCount,
        presetId: activePreset?.id ?? null,
        projectId: effectiveProjectId || null,
        referenceAssetIds,
        // For brand-new generations we send any in-composer files alongside
        // the persisted referenceAssetIds. Retries skip this and reuse the
        // already-uploaded ids only — which is why we do the upload first.
        uploadedFiles: referenceAssetIds.length === files.length ? [] : files,
        generationParameters,
      });
      if (outcome.status === "failed") {
        setError(outcome.error ?? t("studio.generationFailed"));
      } else {
        setNotice(t("studio.generatedImages", { count: outcome.succeededCount }));
      }
    } catch (generateError) {
      if (entryId) {
        if (isRequestAbortedError(generateError)) {
          history.update(entryId, { status: "canceled", error: null });
        } else {
          const message = toErrorMessage(generateError, t("studio.generationFailed"));
          history.update(entryId, { status: "failed", error: message });
        }
      } else {
        setError(toErrorMessage(generateError, t("studio.generationFailed")));
      }
    } finally {
      isSubmittingRef.current = false;
      setIsGenerating(false);
    }
  }, [
    t,
    prompt,
    selectedPreset,
    files,
    generationMode,
    history,
    selectedVideoModelId,
    selectedVideoModel,
    videoDuration,
    videoGen,
    projectId,
    activeImageModelId,
    aspectRatio,
    imageOutputCount,
    imageRunMode,
    batchVariants,
    generationParameters,
    runImageGenerationRequest,
    uploadReferenceAssets,
    handleCreateProject,
  ]);

  // Retry a previous entry — rebuilds the exact same request from the snapshot
  // captured in history (no re-uploading of references, no re-derivation of
  // prompt). Behaves like a fresh submit but bypasses the composer state.
  const handleRegenerate = useCallback(
    async (entryId: string) => {
      const entry = history.find(entryId);
      // Image-only: retry rebuilds the request from the history snapshot. Video
      // can't be reconstructed (the reference upload isn't reproducible), so the
      // results grid hides the retry/regenerate affordance for video entries and
      // this guard is the matching backstop.
      if (!entry || entry.mode !== "image") return;
      await regenerateSingleFlight.run(entryId, async () => {
        setError("");
        setIsGenerating(true);
        // Re-flag the entry as running so its tile flips back to the skeleton
        // state immediately (instead of waiting for the network round-trip).
        history.update(entryId, { status: "running", error: null });
        try {
          const outcome = await runImageGenerationRequest({
            entryId,
            prompt: entry.prompt,
            modelId: entry.modelId,
            aspectRatio: entry.aspectRatio,
            count: entry.count,
            presetId: entry.presetId,
            projectId: entry.projectId,
            referenceAssetIds: entry.referenceAssetIds,
            uploadedFiles: [],
            generationParameters: entry.generationParameters ?? {},
          });
          if (outcome.status === "failed") {
            setError(outcome.error ?? t("studio.generationFailed"));
          }
        } catch (regenError) {
          history.update(
            entryId,
            isRequestAbortedError(regenError)
              ? { status: "canceled", error: null }
              : {
                  status: "failed",
                  error: toErrorMessage(regenError, t("studio.generationFailed")),
                },
          );
        } finally {
          setIsGenerating(false);
        }
      });
    },
    [history, regenerateSingleFlight, runImageGenerationRequest, t],
  );

  // Send an already-generated image into a Canvas session for fine-tuning.
  // Creates a fresh session per click (we used to try to reuse via
  // findReusableSession; that was tied to the old auto-run flow). Opens the
  // canvas in the SAME tab — feels intentional for the "精修" action.
  const handleSendToCanvas = useCallback(
    async (entryId: string, asset: AssetDTO) => {
      const entry = history.find(entryId);
      if (!entry) return;
      setError("");
      try {
        const { url } = await sendAssetToCanvas({
          assetId: asset.id,
          title: t("studio.canvasTitle"),
          projectId: entry.projectId || undefined,
        });
        router.push(addCanvasEntrySource(url, "studio"));
      } catch (sendError) {
        setError(toErrorMessage(sendError, t("studio.canvasCreateFailed")));
      }
    },
    [history, router, t],
  );

  const handleDismissEntry = useCallback(
    (entryId: string) => history.remove(entryId),
    [history],
  );

  const handleReuseParameters = useCallback((entryId: string) => {
    const entry = history.find(entryId);
    if (!entry || entry.mode !== "image") return;
    setGenerationParameters(entry.generationParameters ?? {});
    setNotice(t("studio.parametersReused"));
    textareaRef.current?.focus();
  }, [history, t]);

  const handleCancelGeneration = useCallback(
    async (entryId: string) => {
      const control = imageRequestControlsRef.current.get(entryId);
      if (!control || control.cancelRequested) return;
      control.cancelRequested = true;
      setError("");
      try {
        await requestSdCancellation(control.runId);
      } catch {
        const current = imageRequestControlsRef.current.get(entryId);
        if (current?.runId === control.runId) {
          current.cancelRequested = false;
          setError(t("studio.cancelFailed"));
        }
        return;
      }

      const current = imageRequestControlsRef.current.get(entryId);
      if (current?.runId !== control.runId) return;
      history.update(entryId, { status: "canceled", error: null });
      setSdProgressByEntry((current) => {
        const progress = current[entryId];
        if (!progress || progress.runId !== control.runId) return current;
        return {
          ...current,
          [entryId]: { ...progress, phase: "canceled", updatedAtMs: Date.now() },
        };
      });
      control.requestController.abort();
      control.pollController.abort();
    },
    [history, t],
  );

  // Stable void-returning adapters so the memo()'d results grid actually skips
  // re-renders during composer typing. The grid's props are `=> void`; the
  // underlying handlers are async, so we discard the promise here once (instead
  // of via a fresh inline arrow on every render that defeated the memo).
  const handleGridRegenerate = useCallback(
    (entryId: string) => void handleRegenerate(entryId),
    [handleRegenerate],
  );
  const handleGridSendToCanvas = useCallback(
    (entryId: string, asset: AssetDTO) => void handleSendToCanvas(entryId, asset),
    [handleSendToCanvas],
  );
  const handleGridCancel = useCallback(
    (entryId: string) => void handleCancelGeneration(entryId),
    [handleCancelGeneration],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handleGenerate();
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Local history is only readable after hydration, so the first frame cannot
  // know whether the composer is centered or pushed up by results. Show a
  // visible loading shell with the same footprint instead of rendering the real
  // surface invisibly — an invisible routed surface reads as a broken page.
  if (!history.hydrated) {
    return (
      <section
        aria-busy="true"
        data-slot="studio-loading-shell"
        className="relative flex w-full flex-1 flex-col justify-center gap-3 pb-20 pt-0 sm:gap-4 sm:pt-1 md:pb-14"
      >
        <div className="mx-auto w-full max-w-5xl space-y-3">
          <Skeleton className="h-40 rounded-2xl bg-(--bg-surface)" />
          <Skeleton className="mx-auto h-8 w-64 rounded-xl bg-(--bg-surface)" />
        </div>
      </section>
    );
  }

  return (
    <>
      <PageReveal className="flex w-full flex-1">
      <section
        className={cn(
        // flex-1 fills the shell's vertical canvas (content-frame is now a
        // full-height flex column), so this owns the whole console height
        // instead of a magic 70vh inline patch.
        "relative flex w-full flex-1 flex-col pb-20 pt-0 sm:pt-1 md:pb-14",
        // Center the initial composer; result history restores normal top flow.
        hasResults ? "space-y-3 sm:space-y-4" : "justify-center gap-3 sm:gap-4",
        )}
      >
      <StudioCapabilityBanner
        readiness={readiness}
        focusId={generationMode === "image" ? "imageGeneration" : "videoGeneration"}
      />

      {/* ── Composer ── */}
      <div className="relative z-20 mx-auto w-full max-w-5xl">
        <Input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />

          <div
            className={cn(
              "group/composer relative overflow-hidden rounded-2xl border border-(--border-active) bg-(--bg-surface) px-4 py-3 shadow-[var(--shadow-lg),var(--shadow-glow)] transition-[border-color,box-shadow] duration-(--motion-control) focus-within:border-(--accent-primary)/40 sm:px-5 sm:py-4",
              COMPOSER_DECK_LAYOUT_CLASS
            )}
          >
            <div className="pointer-events-none absolute inset-0 bg-linear-to-br from-(--bg-glass) via-transparent to-transparent" />

            <ComposerDeck
              filePreviews={filePreviews}
              draggingPreviewKey={draggingPreviewKey}
              dragOverPreviewKey={dragOverPreviewKey}
              onOpenFilePicker={handleOpenFilePicker}
              onRemoveFile={handleRemoveFile}
              onMoveFile={handleMoveFile}
              onDragStart={handlePreviewDragStart}
              onDragEnd={handlePreviewDragEnd}
              onDragOver={handlePreviewDragOver}
              onDragLeave={handlePreviewDragLeave}
              onDrop={handleDropOnPreview}
              removeLabel={t("studio.removeReference")}
              addLabel={t("studio.addReference")}
              moveBeforeLabel={t("studio.moveReferenceBefore")}
              moveAfterLabel={t("studio.moveReferenceAfter")}
            />

            {/* Textarea */}
            <div className="relative">
              <Textarea
                id="studio-prompt-input"
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={composerPlaceholder}
                rows={3}
                className={cn(
                  "relative min-h-28 w-full resize-none border-0 bg-transparent px-4 pb-4 text-sm leading-relaxed text-foreground shadow-none outline-none ring-0 transition-colors placeholder:text-muted-foreground/50 focus:border-0 focus:placeholder:text-muted-foreground/40 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none focus-visible:outline-offset-0 focus-visible:ring-0 md:min-h-24 md:pt-5",
                  // Reserve deck space only when reference previews exist.
                  filePreviews.length > 0
                    ? "pt-28 pl-4 md:pl-[var(--composer-deck-offset)]"
                    : cn("pt-2", COMPOSER_TEXTAREA_OFFSET_CLASS)
                )}
              />
            </div>

            {/* Controls wrap on the left while the primary action stays anchored. */}
            <div className="relative mt-1.5 flex items-end justify-between gap-2 border-t border-(--border-subtle) pt-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ToggleGroup
                type="single"
                value={generationMode}
                onValueChange={(value) => {
                  if (value === "image" || value === "video") {
                    setGenerationMode(value);
                  }
                }}
                className="rounded-md bg-(--bg-elevated) p-0.5"
                size="sm"
              >
                <ToggleGroupItem value="image" aria-label={t("studio.imageMode")} className="h-7 px-2.5 text-xs">
                  {t("studio.imageMode")}
                </ToggleGroupItem>
                <ToggleGroupItem value="video" aria-label={t("studio.videoMode")} className="h-7 px-2.5 text-xs">
                  {t("studio.videoMode")}
                </ToggleGroupItem>
              </ToggleGroup>

              {generationMode === "image" ? (
                <ToggleGroup
                  type="single"
                  value={imageRunMode}
                  onValueChange={(value) => {
                    if (value === "single" || value === "batch") setImageRunMode(value);
                  }}
                  className="rounded-md bg-(--bg-elevated) p-0.5"
                  size="sm"
                >
                  <ToggleGroupItem value="single" className="h-7 px-2.5 text-xs">
                    {t("studio.singleMode")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="batch" className="h-7 px-2.5 text-xs">
                    {t("studio.batchMode")}
                  </ToggleGroupItem>
                </ToggleGroup>
              ) : null}

              {generationMode === "image" ? (
                <PresetPicker
                  open={presetPickerOpen}
                  onOpenChange={setPresetPickerOpen}
                  activeCategory={activePresetCategory}
                  onCategoryChange={setActivePresetCategory}
                  filteredPresets={filteredPresets}
                  selectedPresetId={selectedPresetId}
                  selectedPreset={selectedPreset}
                  onSelectPreset={handleSelectPreset}
                  onClearSelection={handleClearPresetSelection}
                  isZh={isZh}
                  stylePresetLabel={t("studio.stylePreset")}
                  clearSelectionLabel={t("studio.clearSelection")}
                />
              ) : null}

              <StudioOptionsPopover
                mode={generationMode}
                imageModels={imageModels}
                activeImageModelId={activeImageModelId}
                hasImageModels={hasImageModels}
                onImageModelChange={setSelectedModel}
                aspectRatio={aspectRatio}
                onAspectRatioChange={setAspectRatio}
                candidateCount={imageOutputCount}
                selectedPreset={selectedPreset}
                videoModels={videoModels}
                selectedVideoModelId={selectedVideoModelId}
                videoDuration={videoDuration}
                onVideoModelChange={setVideoModelId}
                onVideoDurationChange={setVideoDuration}
                hasVideoReference={hasVideoReference}
                projectId={projectId}
                projects={uniqueProjects}
                onProjectChange={handleProjectChange}
                onCreateProject={handleCreateProjectVoid}
                isCreatingProject={isCreatingProject}
                isZh={isZh}
                generationParameters={generationParameters}
                onGenerationParametersChange={setGenerationParameters}
                labels={optionsLabels}
              />

              {activeProjectName ? (
                <span
                  className="max-w-44 truncate rounded-md border border-(--border-subtle) bg-(--bg-glass) px-2 py-1 text-xs text-(--text-secondary)"
                  title={activeProjectName}
                >
                  {t("studio.projectTarget", { name: activeProjectName })}
                </span>
              ) : null}

              {files.length > 0 ? (
                <span className="text-xs text-(--text-muted)">
                  {t("studio.refsCount", { count: files.length })}
                </span>
              ) : null}

              {canRefinePrompt ? (
                <Button
                  type="button"
                  onClick={() => void handleOptimizePrompt()}
                  loading={isOptimizing}
                  disabled={isGenerating}
                  variant="ghostMuted"
                  size="xs"
                  className="h-8 px-2.5"
                >
                  <Wand2 className="h-3.5 w-3.5" />
                  {refinePromptLabel}
                </Button>
              ) : prompt.trim() ? (
                <div className="flex basis-full items-center gap-2 text-xs text-(--text-muted)">
                  <span className="min-w-0 flex-1 leading-snug">
                    {disabledRefineReason}
                  </span>
                  {readiness.byId.promptRefinement.href && readiness.byId.promptRefinement.actionLabel ? (
                    <Button
                      type="button"
                      variant="ghostMuted"
                      size="xs"
                      className="h-7 shrink-0"
                      onClick={() => router.push(readiness.byId.promptRefinement.href!)}
                    >
                      {readiness.byId.promptRefinement.actionLabel}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              </div>

              {/* Right zone: primary action + (when generatable) the keyboard
                  shortcut hint. Stays anchored to the right at every breakpoint. */}
              <div className="flex shrink-0 flex-col items-end gap-1">
                {/* Show the shortcut only when it can be used. */}
                {modeCanGenerate ? (
                  <span className="hidden text-xs leading-none text-(--text-muted) sm:block">
                    {shortcutHint}
                  </span>
                ) : null}
                {/* Setup remains in the readiness banner; Create stays disabled here. */}
                {!modeHasBackend ? (
                  <Button
                    type="button"
                    disabled
                    variant="accent"
                    size="cta"
                    aria-label={t("studio.startGenerate")}
                    title={modeReadiness.reason ?? modeReadiness.detail}
                  >
                    <Send className="h-4 w-4" />
                    <span className="ml-1">{t("studio.startCrafting")}</span>
                  </Button>
                ) : videoNeedsReference ? (
                  <Button
                    type="button"
                    onClick={handleOpenFilePicker}
                    disabled={
                      isGenerating ||
                      isOptimizing ||
                      videoGen.status === "submitting" ||
                      videoGen.status === "running"
                    }
                    variant="accent"
                    size="cta"
                    aria-label={t("studio.addReference")}
                  >
                    <ImagePlus className="h-4 w-4" />
                    <span className="ml-1">{t("studio.addReference")}</span>
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={() => void handleGenerate()}
                    loading={isGenerating}
                    disabled={
                      isOptimizing ||
                      videoGen.status === "submitting" ||
                      videoGen.status === "running" ||
                      !modeCanGenerate
                    }
                    variant="accent"
                    size="cta"
                    aria-label={t("studio.startGenerate")}
                    title={disabledGenerateReason}
                  >
                    <Send className="h-4 w-4" />
                    <span className="ml-1">
                      {imageRunMode === "batch"
                        ? t("studio.generateVariants", { count: imageOutputCount })
                        : t("studio.startCrafting")}
                    </span>
                  </Button>
                )}
              </div>
            </div>
          </div>

          {notice ? (
            <p
              role="status"
              aria-live="polite"
              className="px-5 pb-2 text-xs font-medium text-primary sm:px-6"
            >
              {notice}
            </p>
          ) : null}

          {/* Error */}
          {error ? (
            <p
              role="alert"
              aria-live="assertive"
              className="px-5 pb-3 text-xs font-medium text-destructive sm:px-6"
            >
              {error}
            </p>
          ) : null}

      </div>

        {/* This-session generation grid — now follows the composer so the
            primary input stays in the first reading pass. */}
        <GenerationResultsGrid
          entries={history.entries}
          progressByEntry={sdProgressByEntry}
          busy={isGenerating || isOptimizing}
          onRegenerate={handleGridRegenerate}
          onSendToCanvas={handleGridSendToCanvas}
          onDismiss={handleDismissEntry}
          onCancel={handleGridCancel}
          onReuseParameters={handleReuseParameters}
        />

      </section>
      </PageReveal>
      <ProjectNameDialog
        open={projectNameDialogOpen}
        name={projectNameDraft}
        title={t("studio.newProject")}
        description={t("library.projectNameDescription")}
        inputLabel={t("agent.projectName")}
        submitLabel={t("studio.newProject")}
        cancelLabel={t("common.cancel")}
        pending={isCreatingProject}
        error={projectNameError}
        onNameChange={setProjectNameDraft}
        onOpenChange={(open) => {
          setProjectNameDialogOpen(open);
          if (!open) setProjectNameError("");
        }}
        onSubmit={handleProjectNameSubmit}
      />
    </>
  );
}
