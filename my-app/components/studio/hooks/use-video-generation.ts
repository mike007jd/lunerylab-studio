"use client";

import { useMemo } from "react";
import { fetchJson, HttpError, toErrorMessage } from "@/lib/client/fetch-json";
import {
  videoCreateResponseSchema,
  videoStatusResponseSchema,
  type VideoStatusResponse,
} from "@/lib/schemas/generation";
import type { TFunction } from "@/lib/i18n/provider";
import type {
  UseStudioGenerationHistoryResult,
} from "@/components/studio/use-studio-generation-history";
import type { GenerationActivityRegistry } from "@/components/studio/controllers/generation-activity-registry";

type PollErrorKind =
  | "network"
  | "server_5xx"
  | "job_missing"
  | "client_4xx"
  | "timeout";

export interface VideoGenerationSubmitInput {
  prompt: string;
  modelId: string;
  duration: number;
  aspectRatio: string;
  projectId: string | null;
  presetId: string | null;
  referenceFiles: File[];
  uploadReferenceAssets: (projectId: string, signal: AbortSignal) => Promise<string[]>;
}

export type VideoGenerationResult =
  | { started: false }
  | { started: true; entryId: string; error: string | null; stale: boolean };

interface VideoGenerationControllerOptions {
  registry: GenerationActivityRegistry;
  history: Pick<UseStudioGenerationHistoryResult, "add" | "update" | "find">;
  t: TFunction;
  request?: typeof fetchJson<unknown>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  createRunId?: () => string;
  pollIntervalMs?: number;
  maxPollErrors?: number;
}

interface VideoRunInput {
  entryId: string;
  prompt: string;
  modelId: string;
  duration: number;
  aspectRatio: string;
  projectId: string | null;
  referenceAssetIds: string[];
  /** When set, rejoin this provider job instead of creating a new one. */
  rejoinJobId?: string | null;
}

function classifyPollError(error: unknown): PollErrorKind {
  if (error instanceof HttpError) {
    if (error.status >= 500) return "server_5xx";
    if (error.status === 404 || error.status === 410) return "job_missing";
    if (error.status >= 400) return "client_4xx";
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("timeout") || message.includes("timed out") ? "timeout" : "network";
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function videoPollFailureMessage(kind: PollErrorKind): string {
  return kind === "job_missing"
    ? "Video job not found"
    : "Connection lost. Check your network.";
}

export function createVideoGenerationController({
  registry,
  history,
  t,
  request = fetchJson<unknown>,
  wait = abortableDelay,
  createRunId = () => crypto.randomUUID(),
  pollIntervalMs = 12_000,
  maxPollErrors = 3,
}: VideoGenerationControllerOptions) {
  const finishWithStatus = (
    entryId: string,
    runId: string,
    payload: VideoStatusResponse,
  ): boolean => {
    if (!registry.isCurrent(entryId, runId)) return true;
    if (payload.status === "RUNNING") {
      history.update(entryId, { status: "running", error: null });
      return false;
    }
    if (payload.status === "FAILED") {
      // Authoritative failure clears the session job id so retry creates fresh.
      history.update(entryId, { status: "failed", error: payload.error, jobId: null });
      return true;
    }
    history.update(entryId, {
      status: payload.asset ? "succeeded" : "failed",
      assets: payload.asset ? [payload.asset] : [],
      error: payload.asset ? null : t("studio.videoFailed"),
      jobId: payload.asset ? history.find(entryId)?.jobId ?? null : null,
    });
    return true;
  };

  const poll = async (
    entryId: string,
    runId: string,
    jobId: string,
    pollController: AbortController,
  ): Promise<void> => {
    let consecutiveErrors = 0;
    try {
      while (registry.isCurrent(entryId, runId) && !pollController.signal.aborted) {
        try {
          const payload = videoStatusResponseSchema.parse(
            await request(`/api/generate/video/${jobId}/status`, {
              signal: pollController.signal,
            }),
          );
          if (!registry.isCurrent(entryId, runId)) return;
          consecutiveErrors = 0;
          if (finishWithStatus(entryId, runId, payload)) return;
        } catch (error) {
          if (!registry.isCurrent(entryId, runId) || pollController.signal.aborted) return;
          const kind = classifyPollError(error);
          consecutiveErrors += 1;
          if (kind === "job_missing") {
            // Authoritative not-found clears jobId so retry creates a new job.
            history.update(entryId, {
              status: "failed",
              error: videoPollFailureMessage(kind),
              jobId: null,
            });
            return;
          }
          if (consecutiveErrors >= maxPollErrors) {
            // Release global generation ownership after a bounded outage so
            // the WebView cannot become permanently busy. Keep jobId: Retry
            // rejoins this same billable job and never creates a second one.
            history.update(entryId, {
              status: "interrupted",
              error: videoPollFailureMessage(kind),
            });
            return;
          }
        }
        await wait(pollIntervalMs, pollController.signal);
      }
    } finally {
      registry.finish(entryId, runId);
    }
  };

  const execute = async (
    {
      entryId,
      prompt,
      modelId,
      duration,
      aspectRatio,
      projectId,
      referenceAssetIds,
      rejoinJobId,
    }: VideoRunInput,
    runId: string,
    requestController: AbortController,
    pollController: AbortController,
  ): Promise<VideoGenerationResult> => {
    try {
      let jobId = rejoinJobId?.trim() || null;

      if (!jobId) {
        const formData = new FormData();
        formData.append("prompt", prompt);
        formData.append("modelId", modelId);
        formData.append("duration", String(duration));
        formData.append("aspectRatio", aspectRatio);
        formData.append("idempotencyKey", crypto.randomUUID());
        if (projectId) formData.append("projectId", projectId);
        if (referenceAssetIds[0]) formData.append("referenceAssetId", referenceAssetIds[0]);

        const response = videoCreateResponseSchema.parse(
          await request("/api/generate/video", {
            method: "POST",
            body: formData,
            signal: requestController.signal,
          }),
        );
        if (!registry.isCurrent(entryId, runId)) {
          return { started: true, entryId, error: null, stale: true };
        }
        jobId = response.jobId;
        history.update(entryId, {
          status: "running",
          warnings: response.warnings ?? [],
          jobId,
          error: null,
        });
      } else {
        if (!registry.isCurrent(entryId, runId)) {
          return { started: true, entryId, error: null, stale: true };
        }
        history.update(entryId, { status: "running", error: null, jobId });
      }

      void poll(entryId, runId, jobId, pollController);
      return { started: true, entryId, error: null, stale: false };
    } catch (error) {
      if (!registry.isCurrent(entryId, runId)) {
        return { started: true, entryId, error: null, stale: true };
      }
      const message = toErrorMessage(error, t("studio.videoFailed"));
      history.update(entryId, { status: "failed", error: message, jobId: null });
      registry.finish(entryId, runId);
      return { started: true, entryId, error: message, stale: false };
    }
  };

  const run = async (
    input: VideoRunInput,
    onStarted?: () => void,
  ): Promise<VideoGenerationResult> => {
    const runId = createRunId();
    const requestController = new AbortController();
    const pollController = new AbortController();
    if (
      !registry.begin({
        entryId: input.entryId,
        runId,
        mode: "video",
        requestController,
        pollController,
      })
    ) {
      return { started: false };
    }
    onStarted?.();
    return execute(input, runId, requestController, pollController);
  };

  const submit = async (input: VideoGenerationSubmitInput): Promise<VideoGenerationResult> => {
    if (registry.anyActive()) return { started: false };
    const entryId = history.add({
      mode: "video",
      prompt: input.prompt,
      modelId: input.modelId,
      aspectRatio: input.aspectRatio,
      count: 1,
      presetId: input.presetId,
      projectId: input.projectId,
      referenceAssetIds: [],
      batchVariants: null,
      generationParameters: {},
      videoDuration: input.duration,
      jobId: null,
    });
    const runId = createRunId();
    const requestController = new AbortController();
    const pollController = new AbortController();
    if (
      !registry.begin({
        entryId,
        runId,
        mode: "video",
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
        return { started: true, entryId, error: null, stale: true };
      }
      const aborted = error instanceof DOMException && error.name === "AbortError";
      const message = aborted ? null : toErrorMessage(error, t("studio.videoFailed"));
      history.update(entryId, {
        status: aborted ? "canceled" : "failed",
        error: message,
        jobId: null,
      });
      registry.finish(entryId, runId);
      return { started: true, entryId, error: message, stale: false };
    }
    if (!registry.isCurrent(entryId, runId)) {
      return { started: true, entryId, error: null, stale: true };
    }
    history.update(entryId, { referenceAssetIds });
    return execute(
      {
        entryId,
        prompt: input.prompt,
        modelId: input.modelId,
        duration: input.duration,
        aspectRatio: input.aspectRatio,
        projectId: input.projectId,
        referenceAssetIds,
      },
      runId,
      requestController,
      pollController,
    );
  };

  const retry = async (entryId: string): Promise<VideoGenerationResult> => {
    const entry = history.find(entryId);
    if (!entry || entry.mode !== "video" || entry.videoDuration == null) {
      return { started: false };
    }
    const rejoinJobId = entry.jobId;
    return run(
      {
        entryId,
        prompt: entry.prompt,
        modelId: entry.modelId,
        duration: entry.videoDuration,
        aspectRatio: entry.aspectRatio,
        projectId: entry.projectId,
        referenceAssetIds: entry.referenceAssetIds,
        rejoinJobId,
      },
      () =>
        history.update(entryId, {
          status: "running",
          error: null,
          assets: [],
          // Retain jobId across interrupt→retry rejoin; cleared only on
          // authoritative failure / not-found.
          jobId: rejoinJobId ?? null,
        }),
    );
  };

  return { submit, retry };
}

export function useVideoGenerationController({
  registry,
  history,
  t,
}: {
  registry: GenerationActivityRegistry;
  history: UseStudioGenerationHistoryResult;
  t: TFunction;
}) {
  return useMemo(
    () => createVideoGenerationController({ registry, history, t }),
    [history, registry, t],
  );
}
