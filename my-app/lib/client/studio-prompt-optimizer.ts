import { fetchJson } from "@/lib/client/fetch-json";
import type { PromptOptimizeRequest, PromptOptimizeResponse } from "@/lib/types/api";
import type { VideoModelEntry } from "@/lib/video-models";

type StudioGenerationType = "image" | "video";

export type StudioPromptOptimizeValidationKey =
  | "studio.setupHint.refineDisabled"
  | "studio.promptRequired";

export type StudioPromptOptimizeNoticeKey =
  | "studio.promptRuleFallback"
  | "studio.promptOptimized";

export type StudioPromptOptimizePayload = PromptOptimizeRequest & {
  generationType: StudioGenerationType;
  videoModelId?: string;
  videoDuration?: number;
  presetName?: string;
  presetGuidance?: string;
};

export interface StudioPromptOptimizeInput {
  prompt: string;
  mode: PromptOptimizeRequest["mode"];
  referenceCount: number;
  locale: string;
  generationType: StudioGenerationType;
  videoModels: Pick<VideoModelEntry, "id" | "providerModelId">[];
  selectedVideoModelId: string;
  videoDuration: number;
  presetName?: string;
  presetGuidance?: string;
}

export interface StudioPromptOptimizeResult {
  optimizedPrompt: string;
  noticeKey: StudioPromptOptimizeNoticeKey;
  response: PromptOptimizeResponse;
}

export function validateStudioPromptOptimizeInput(input: {
  canRefinePrompt: boolean;
  prompt: string;
  hasSelectedPreset: boolean;
}): StudioPromptOptimizeValidationKey | null {
  if (!input.canRefinePrompt) return "studio.setupHint.refineDisabled";
  if (!input.prompt.trim() && !input.hasSelectedPreset) return "studio.promptRequired";
  return null;
}

export function resolvePromptOptimizeVideoModelId(input: {
  generationType: StudioGenerationType;
  videoModels: Pick<VideoModelEntry, "id" | "providerModelId">[];
  selectedVideoModelId: string;
}): string | undefined {
  if (input.generationType !== "video") return undefined;
  return input.videoModels.find(
    (model) => model.id === input.selectedVideoModelId || model.providerModelId === input.selectedVideoModelId,
  )?.id;
}

export function buildStudioPromptOptimizePayload(input: StudioPromptOptimizeInput): StudioPromptOptimizePayload {
  return {
    prompt: input.prompt,
    mode: input.mode,
    referenceCount: input.referenceCount,
    locale: input.locale,
    generationType: input.generationType,
    videoModelId: resolvePromptOptimizeVideoModelId(input),
    videoDuration: input.generationType === "video" ? input.videoDuration : undefined,
    presetName: input.presetName,
    presetGuidance: input.presetGuidance,
  };
}

export function promptOptimizeNoticeKey(provider: PromptOptimizeResponse["provider"]): StudioPromptOptimizeNoticeKey {
  return provider === "rule-fallback" ? "studio.promptRuleFallback" : "studio.promptOptimized";
}

export async function optimizeStudioPrompt(input: StudioPromptOptimizeInput): Promise<StudioPromptOptimizeResult> {
  const response = await fetchJson<PromptOptimizeResponse>("/api/prompts/optimize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildStudioPromptOptimizePayload(input)),
  });

  return {
    optimizedPrompt: response.optimizedPrompt,
    noticeKey: promptOptimizeNoticeKey(response.provider),
    response,
  };
}
