"use client";

import { useCallback, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import type { TFunction } from "@/lib/i18n/provider";
import type { AssetDTO } from "@/lib/types/api";
import type { ImageModelEntry } from "@/lib/image-models";
import {
  filterGenerationParametersToCapabilities,
  resolveImageAdvancedParameters,
} from "@/lib/image-models";
import type { GenerationParameters } from "@/lib/generation-parameters";
import type { StylePreset } from "@/lib/presets/style-presets";
import type { VideoModelEntry } from "@/lib/video-models";
import { toErrorMessage } from "@/lib/client/fetch-json";
import { sendAssetToCanvas } from "@/lib/client/canvas-sessions";
import { addCanvasEntrySource } from "@/lib/client/creation-flow";
import type { useImageGenerationController } from "@/components/studio/hooks/use-image-generation-controller";
import type { useVideoGenerationController } from "@/components/studio/hooks/use-video-generation";
import type {
  GenerationBatchVariant,
  UseStudioGenerationHistoryResult,
} from "@/components/studio/use-studio-generation-history";

interface UseStudioGenerationActionsOptions {
  history: UseStudioGenerationHistoryResult;
  imageGeneration: ReturnType<typeof useImageGenerationController>;
  videoGeneration: ReturnType<typeof useVideoGenerationController>;
  generationMode: "image" | "video";
  prompt: string;
  selectedVideoModel?: VideoModelEntry;
  selectedVideoModelId: string;
  videoDuration: number;
  aspectRatio: string;
  projectId: string;
  selectedPreset: StylePreset | null;
  files: File[];
  uploadReferenceAssets: (projectId: string, signal?: AbortSignal) => Promise<string[]>;
  imageRunMode: "single" | "batch";
  activeImageModelId: string;
  imageOutputCount: number;
  batchVariants?: readonly GenerationBatchVariant[];
  generationParameters: GenerationParameters;
  imageModels: ImageModelEntry[];
  setGenerationParameters: Dispatch<SetStateAction<GenerationParameters>>;
  onCreateProject: () => void;
  onFocusPrompt: () => void;
  navigate: (href: string) => void;
  t: TFunction;
  setError: (error: string) => void;
  setNotice: (notice: string) => void;
}

export function useStudioGenerationActions({
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
  onCreateProject,
  onFocusPrompt,
  navigate,
  t,
  setError,
  setNotice,
}: UseStudioGenerationActionsOptions) {
  const generate = useCallback(async () => {
    setError("");

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
      if (!projectId && files.length > 0) {
        onCreateProject();
        return;
      }
      const result = await videoGeneration.submit({
        prompt: workingPrompt,
        modelId: selectedVideoModelId,
        duration: videoDuration,
        aspectRatio,
        projectId: projectId || null,
        presetId: selectedPreset?.id ?? null,
        referenceFiles: files,
        uploadReferenceAssets,
      });
      if (result.started && !result.error && !result.stale) {
        setNotice(t("studio.videoStarted"));
      } else if (result.started && result.error) {
        setError(result.error);
      }
      return;
    }

    const workingPrompt = prompt.trim() || selectedPreset?.promptGuidance || "";
    if (!workingPrompt) {
      setError(t("studio.validation"));
      return;
    }
    if (imageRunMode === "batch" && batchVariants?.length && files.length === 0) {
      setError(t("studio.batchRequiresRef"));
      return;
    }
    if (!activeImageModelId) {
      setError(t("studio.taskIntents.noBackend"));
      return;
    }
    if (!projectId && files.length > 0) {
      onCreateProject();
      return;
    }

    const result = await imageGeneration.submit({
      prompt: workingPrompt,
      modelId: activeImageModelId,
      aspectRatio,
      count: imageOutputCount,
      presetId: selectedPreset?.id ?? null,
      projectId: projectId || null,
      batchVariants:
        batchVariants?.map((variant) => ({
          key: variant.key,
          label: variant.label,
          promptSuffix: variant.promptSuffix,
        })) ?? null,
      generationParameters,
      referenceFiles: files,
      uploadReferenceAssets,
    });
    if (result.started && result.error) {
      setError(result.error);
    } else if (result.started && result.outcome && !result.stale) {
      setNotice(t("studio.generatedImages", { count: result.outcome.succeededCount }));
    }
  }, [
    activeImageModelId,
    aspectRatio,
    batchVariants,
    files,
    generationMode,
    generationParameters,
    imageGeneration,
    imageOutputCount,
    imageRunMode,
    onCreateProject,
    projectId,
    prompt,
    selectedPreset,
    selectedVideoModel,
    selectedVideoModelId,
    setError,
    setNotice,
    t,
    uploadReferenceAssets,
    videoDuration,
    videoGeneration,
  ]);

  const regenerate = useCallback(
    async (entryId: string) => {
      const entry = history.find(entryId);
      if (!entry) return;
      setError("");
      if (entry.mode === "image") {
        const result = await imageGeneration.retry(entryId);
        if (result.started && result.error) setError(result.error);
        if (result.started && result.outcome && !result.stale) {
          setNotice(t("studio.generatedImages", { count: result.outcome.succeededCount }));
        }
      } else {
        const result = await videoGeneration.retry(entryId);
        if (result.started && result.error) setError(result.error);
        if (result.started && !result.error && !result.stale) {
          setNotice(t("studio.videoStarted"));
        }
      }
    },
    [history, imageGeneration, setError, setNotice, t, videoGeneration],
  );

  const sendToCanvas = useCallback(
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
        navigate(addCanvasEntrySource(url, "studio"));
      } catch (error) {
        setError(toErrorMessage(error, t("studio.canvasCreateFailed")));
      }
    },
    [history, navigate, setError, t],
  );

  const dismiss = useCallback(
    (entryId: string) => history.remove(entryId),
    [history],
  );

  const reuseParameters = useCallback(
    (entryId: string) => {
      const entry = history.find(entryId);
      if (!entry || entry.mode !== "image") return;
      const selected = imageModels.find(
        (model) =>
          model.id === activeImageModelId ||
          model.providerModelId === activeImageModelId,
      );
      setGenerationParameters(
        filterGenerationParametersToCapabilities(
          entry.generationParameters,
          resolveImageAdvancedParameters(selected),
        ),
      );
      setNotice(t("studio.parametersReused"));
      onFocusPrompt();
    },
    [
      activeImageModelId,
      history,
      imageModels,
      onFocusPrompt,
      setGenerationParameters,
      setNotice,
      t,
    ],
  );

  const cancel = useCallback(
    async (entryId: string) => {
      setError("");
      const entry = history.find(entryId);
      // Image cancellation is the only UI-exposed cancel path. Video cards never
      // receive Cancel, and this action must not invoke the video client cancel.
      if (!entry || entry.mode !== "image") return;
      try {
        await imageGeneration.cancel(entryId);
      } catch {
        setError(t("studio.cancelFailed"));
      }
    },
    [history, imageGeneration, setError, t],
  );

  const onPromptKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void generate();
      }
    },
    [generate],
  );

  return {
    generate,
    onPromptKeyDown,
    regenerate,
    sendToCanvas,
    dismiss,
    cancel,
    reuseParameters,
  };
}
