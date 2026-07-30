import type { ImageModelEntry } from "@/lib/image-models";
import {
  filterGenerationParametersToCapabilities,
  resolveImageAdvancedParameters,
} from "@/lib/image-models";
import type { GenerationParameters } from "@/lib/generation-parameters";
import {
  createPreparingProgress,
  isRequestAbortedError,
  pollSdProgress,
  requestSdCancellation,
} from "@/lib/client/sd-progress";
import { fetchJson } from "@/lib/client/fetch-json";
import { toActionableGenerationError } from "@/lib/client/generation-errors";
import {
  resolveImageGenerationOutcome,
  type ImageGenerationOutcome,
} from "@/lib/client/generation-presentation";
import { generationResponseSchema } from "@/lib/schemas/generation";
import type { TFunction } from "@/lib/i18n/provider";
import type { SdProgress } from "@/lib/types/sd-progress";
import type {
  NewEntryInput,
  UseStudioGenerationHistoryResult,
} from "@/components/studio/use-studio-generation-history";
import type { GenerationActivityRegistry } from "./generation-activity-registry";

export interface ImageGenerationSubmitInput {
  prompt: string;
  modelId: string;
  aspectRatio: string;
  count: number;
  presetId: string | null;
  projectId: string | null;
  batchVariants: NewEntryInput["batchVariants"];
  generationParameters: GenerationParameters;
  referenceFiles: File[];
  uploadReferenceAssets: (projectId: string, signal: AbortSignal) => Promise<string[]>;
}

export type ImageGenerationResult =
  | { started: false }
  | {
      started: true;
      entryId: string;
      outcome: ImageGenerationOutcome | null;
      error: string | null;
      stale: boolean;
    };

interface ImageGenerationControllerOptions {
  registry: GenerationActivityRegistry;
  history: Pick<UseStudioGenerationHistoryResult, "add" | "update" | "find">;
  imageModels: ImageModelEntry[];
  t: TFunction;
  setProgress: (
    updater: (current: Record<string, SdProgress | undefined>) => Record<string, SdProgress | undefined>,
  ) => void;
  request?: typeof fetchJson<unknown>;
  pollProgress?: typeof pollSdProgress;
  cancelNative?: typeof requestSdCancellation;
  createRunId?: () => string;
}

interface ImageRunInput {
  entryId: string;
  prompt: string;
  modelId: string;
  aspectRatio: string;
  count: number;
  presetId: string | null;
  projectId: string | null;
  referenceAssetIds: string[];
  generationParameters: GenerationParameters;
}

function buildImageGenerationForm(
  input: ImageRunInput,
  runId: string,
  parameters: GenerationParameters,
): FormData {
  const form = new FormData();
  form.append("runId", runId);
  form.append("prompt", input.prompt);
  form.append("count", String(input.count));
  form.append("aspectRatio", input.aspectRatio);
  form.append("modelId", input.modelId);
  if (parameters.seed !== undefined) form.append("seed", String(parameters.seed));
  if (parameters.steps !== undefined) form.append("steps", String(parameters.steps));
  if (parameters.cfg !== undefined) form.append("cfg", String(parameters.cfg));
  if (parameters.negativePrompt) form.append("negativePrompt", parameters.negativePrompt);
  if (input.projectId) form.append("projectId", input.projectId);
  if (input.presetId) form.append("presetId", input.presetId);
  for (const id of input.referenceAssetIds) form.append("referenceAssetIds", id);
  form.append("idempotencyKey", crypto.randomUUID());
  return form;
}

function parametersFromOutcome(
  current: GenerationParameters,
  outcome: ImageGenerationOutcome,
): GenerationParameters {
  const firstAsset = outcome.assets[0];
  return {
    ...current,
    ...(firstAsset?.generationSeed == null ? {} : { seed: firstAsset.generationSeed }),
    ...(firstAsset?.generationSteps == null ? {} : { steps: firstAsset.generationSteps }),
    ...(firstAsset?.generationCfg == null ? {} : { cfg: firstAsset.generationCfg }),
    ...(firstAsset?.negativePrompt ? { negativePrompt: firstAsset.negativePrompt } : {}),
  };
}

export function createImageGenerationController({
  registry,
  history,
  imageModels,
  t,
  setProgress,
  request = fetchJson<unknown>,
  pollProgress = pollSdProgress,
  cancelNative = requestSdCancellation,
  createRunId = () => crypto.randomUUID(),
}: ImageGenerationControllerOptions) {
  const effectiveParameters = (
    modelId: string,
    parameters: GenerationParameters,
  ): GenerationParameters => {
    const model = imageModels.find(
      (candidate) => candidate.id === modelId || candidate.providerModelId === modelId,
    );
    return filterGenerationParametersToCapabilities(
      parameters,
      resolveImageAdvancedParameters(
        model ?? {
          id: modelId,
          providerModelId: modelId,
          source: modelId.startsWith("byok:") ? "byok" : undefined,
        },
      ),
    );
  };

  const awaitCancellationDecision = async (
    entryId: string,
    runId: string,
  ): Promise<"none" | "confirmed" | "failed"> => {
    const activity = registry.get(entryId);
    if (
      !activity ||
      activity.runId !== runId ||
      !activity.cancelRequested ||
      !activity.cancelAcknowledgement
    ) {
      return "none";
    }
    try {
      await activity.cancelAcknowledgement;
      return registry.isCurrent(entryId, runId) ? "confirmed" : "none";
    } catch {
      return "failed";
    }
  };

  const execute = async (
    input: ImageRunInput,
    runId: string,
    requestController: AbortController,
    pollController: AbortController,
  ): Promise<ImageGenerationResult> => {
    const parameters = effectiveParameters(input.modelId, input.generationParameters);
    setProgress((current) => ({
      ...current,
      [input.entryId]: createPreparingProgress(runId, input.count),
    }));
    void pollProgress({
      runId,
      signal: pollController.signal,
      onProgress: (progress) => {
        if (!registry.isCurrent(input.entryId, runId)) return;
        setProgress((current) => ({ ...current, [input.entryId]: progress }));
      },
    });

    try {
      const payload = await request("/api/generate/images", {
        method: "POST",
        body: buildImageGenerationForm(input, runId, parameters),
        signal: requestController.signal,
      });
      if (!registry.isCurrent(input.entryId, runId)) {
        return { started: true, entryId: input.entryId, outcome: null, error: null, stale: true };
      }
      const cancellation = await awaitCancellationDecision(input.entryId, runId);
      if (!registry.isCurrent(input.entryId, runId)) {
        return { started: true, entryId: input.entryId, outcome: null, error: null, stale: true };
      }
      // Some request implementations can still resolve after abort. Route that
      // completion through the same abort catch so cancellation has one
      // terminal-state owner.
      if (cancellation === "confirmed") {
        const abortError = new Error("Image generation was canceled.");
        abortError.name = "AbortError";
        throw abortError;
      }
      const outcome = resolveImageGenerationOutcome(
        generationResponseSchema.parse(payload),
        t("studio.generationFailed"),
      );
      history.update(input.entryId, {
        status: outcome.status,
        assets: outcome.assets,
        warnings: outcome.warnings,
        error: outcome.error,
        generationParameters: parametersFromOutcome(parameters, outcome),
      });
      return {
        started: true,
        entryId: input.entryId,
        outcome,
        error: outcome.error,
        stale: false,
      };
    } catch (error) {
      if (!registry.isCurrent(input.entryId, runId)) {
        return { started: true, entryId: input.entryId, outcome: null, error: null, stale: true };
      }
      const cancellation = await awaitCancellationDecision(input.entryId, runId);
      if (!registry.isCurrent(input.entryId, runId)) {
        return { started: true, entryId: input.entryId, outcome: null, error: null, stale: true };
      }
      const requestAborted = isRequestAbortedError(error);
      const aborted =
        cancellation === "confirmed" ||
        (cancellation === "none" && requestAborted);
      const message = aborted
        ? null
        : cancellation === "failed" && requestAborted
          ? t("studio.cancelFailed")
          : toActionableGenerationError(error, t("studio.generationFailed"), t);
      history.update(input.entryId, {
        status: aborted ? "canceled" : "failed",
        error: message,
      });
      return {
        started: true,
        entryId: input.entryId,
        outcome: null,
        error: message,
        stale: false,
      };
    } finally {
      pollController.abort();
      if (registry.finish(input.entryId, runId)) {
        setProgress((current) => {
          if (current[input.entryId]?.runId !== runId) return current;
          const next = { ...current };
          delete next[input.entryId];
          return next;
        });
      }
    }
  };

  const run = async (
    input: ImageRunInput,
    onStarted?: () => void,
  ): Promise<ImageGenerationResult> => {
    const runId = createRunId();
    const requestController = new AbortController();
    const pollController = new AbortController();
    if (
      !registry.begin({
        entryId: input.entryId,
        runId,
        mode: "image",
        requestController,
        pollController,
      })
    ) {
      return { started: false };
    }
    onStarted?.();
    return execute(input, runId, requestController, pollController);
  };

  const submit = async (input: ImageGenerationSubmitInput): Promise<ImageGenerationResult> => {
    if (registry.anyActive()) return { started: false };
    const entryId = history.add({
      mode: "image",
      prompt: input.prompt,
      modelId: input.modelId,
      aspectRatio: input.aspectRatio,
      count: input.count,
      presetId: input.presetId,
      projectId: input.projectId,
      referenceAssetIds: [],
      batchVariants: input.batchVariants,
      generationParameters: input.generationParameters,
      videoDuration: null,
      jobId: null,
    });
    const runId = createRunId();
    const requestController = new AbortController();
    const pollController = new AbortController();
    if (
      !registry.begin({
        entryId,
        runId,
        mode: "image",
        requestController,
        pollController,
      })
    ) {
      return { started: false };
    }

    let referenceAssetIds: string[];
    try {
      referenceAssetIds =
        input.projectId && input.referenceFiles.length > 0
          ? await input.uploadReferenceAssets(input.projectId, requestController.signal)
          : [];
    } catch (error) {
      if (!registry.isCurrent(entryId, runId)) {
        return { started: true, entryId, outcome: null, error: null, stale: true };
      }
      const aborted = isRequestAbortedError(error);
      const message = aborted
        ? null
        : toActionableGenerationError(error, t("studio.generationFailed"), t);
      history.update(entryId, {
        status: aborted ? "canceled" : "failed",
        error: message,
      });
      registry.finish(entryId, runId);
      return { started: true, entryId, outcome: null, error: message, stale: false };
    }
    if (!registry.isCurrent(entryId, runId)) {
      registry.finish(entryId, runId);
      return { started: true, entryId, outcome: null, error: null, stale: true };
    }
    history.update(entryId, { referenceAssetIds });
    return execute(
      {
        entryId,
        prompt: input.prompt,
        modelId: input.modelId,
        aspectRatio: input.aspectRatio,
        count: input.count,
        presetId: input.presetId,
        projectId: input.projectId,
        referenceAssetIds,
        generationParameters: input.generationParameters,
      },
      runId,
      requestController,
      pollController,
    );
  };

  const retry = async (entryId: string): Promise<ImageGenerationResult> => {
    const entry = history.find(entryId);
    if (!entry || entry.mode !== "image") return { started: false };
    return run(
      {
        entryId,
        prompt: entry.prompt,
        modelId: entry.modelId,
        aspectRatio: entry.aspectRatio,
        count: entry.count,
        presetId: entry.presetId,
        projectId: entry.projectId,
        referenceAssetIds: entry.referenceAssetIds,
        generationParameters: entry.generationParameters,
      },
      () => history.update(entryId, { status: "running", error: null }),
    );
  };

  const cancel = async (entryId: string): Promise<boolean> => {
    const activity = registry.get(entryId);
    if (!activity || activity.mode !== "image" || activity.cancelRequested) return false;
    const { runId, requestController, pollController } = activity;
    const acknowledgement = cancelNative(runId);
    if (!registry.startCancellation(entryId, runId, acknowledgement)) {
      void acknowledgement.catch(() => undefined);
      return false;
    }
    try {
      await acknowledgement;
    } catch (error) {
      if (registry.isCurrent(entryId, runId)) {
        registry.resetCancellation(entryId, runId);
      }
      throw error;
    }
    if (!registry.isCurrent(entryId, runId)) return false;
    requestController.abort();
    pollController.abort();
    return true;
  };

  return { submit, retry, cancel };
}
