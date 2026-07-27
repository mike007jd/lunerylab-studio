"use client";

import { useCallback, useState } from "react";
import {
  optimizeStudioPrompt,
  validateStudioPromptOptimizeInput,
} from "@/lib/client/studio-prompt-optimizer";
import { toErrorMessage } from "@/lib/client/fetch-json";
import type { TFunction } from "@/lib/i18n/provider";
import type { Locale } from "@/lib/i18n/locale";
import type { StylePreset } from "@/lib/presets/style-presets";
import type { VideoModelEntry } from "@/lib/video-models";
import { DEFAULT_SCENE_MODE } from "@/components/studio/studio-constants";

export function useStudioPromptOptimization({
  canRefinePrompt,
  prompt,
  selectedPreset,
  referenceCount,
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
}: {
  canRefinePrompt: boolean;
  prompt: string;
  selectedPreset: StylePreset | null;
  referenceCount: number;
  locale: Locale;
  generationMode: "image" | "video";
  videoModels: VideoModelEntry[];
  selectedVideoModelId: string;
  videoDuration: number;
  isZh: boolean;
  t: TFunction;
  setPrompt: (prompt: string) => void;
  setError: (error: string) => void;
  setNotice: (notice: string) => void;
}) {
  const [isOptimizing, setIsOptimizing] = useState(false);

  const optimize = useCallback(async () => {
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
        referenceCount,
        locale,
        generationType: generationMode,
        videoModels,
        selectedVideoModelId,
        videoDuration,
        presetName: selectedPreset
          ? isZh
            ? selectedPreset.nameZh
            : selectedPreset.name
          : undefined,
        presetGuidance: selectedPreset?.promptGuidance,
      });
      setPrompt(result.optimizedPrompt);
      setNotice(t(result.noticeKey));
    } catch (error) {
      setError(toErrorMessage(error, t("studio.optimizeFailed")));
    } finally {
      setIsOptimizing(false);
    }
  }, [
    canRefinePrompt,
    generationMode,
    isZh,
    locale,
    prompt,
    referenceCount,
    selectedPreset,
    selectedVideoModelId,
    setError,
    setNotice,
    setPrompt,
    t,
    videoDuration,
    videoModels,
  ]);

  return { isOptimizing, optimize };
}
