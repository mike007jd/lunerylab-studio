import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, HttpError, toErrorMessage } from "@/lib/client/fetch-json";
import type { AssetDTO } from "@/lib/types/api";

type VideoJobStatus = "idle" | "submitting" | "running" | "succeeded" | "failed";

type VideoErrorKind =
  | "network"
  | "server_5xx"
  | "client_4xx"
  | "timeout"
  | "job_failed"
  | "stale"
  | "submit_failed"
  | null;

interface VideoJobState {
  status: VideoJobStatus;
  jobId: string | null;
  asset: AssetDTO | null;
  error: string | null;
  errorKind: VideoErrorKind;
  pollFailCount: number;
}

interface SubmitParams {
  prompt: string;
  modelId: string;
  duration: number;
  projectId?: string;
  referenceImage?: File;
}

interface VideoCreateResponse {
  jobId: string;
}

interface VideoStatusResponse {
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  asset?: AssetDTO;
  error?: string;
}

const POLL_INTERVAL = 12_000;
const MAX_POLL_ERRORS = 3;

type PollErrorKind = "network" | "server_5xx" | "client_4xx" | "timeout";

function classifyPollError(error: unknown): PollErrorKind {
  // HttpError carries the actual status code — read it directly rather than
  // regex-matching the message (which used to break when the server returned
  // a body with no embedded "(NNN ...)" pattern).
  if (error instanceof HttpError) {
    if (error.status >= 500) return "server_5xx";
    if (error.status >= 400) return "client_4xx";
  }
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  return "network";
}

const INITIAL_STATE: VideoJobState = {
  status: "idle",
  jobId: null,
  asset: null,
  error: null,
  errorKind: null,
  pollFailCount: 0,
};

export function useVideoGeneration() {
  const [state, setState] = useState<VideoJobState>(INITIAL_STATE);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollInFlightRef = useRef(false);
  const pollTokenRef = useRef(0);
  const finishedRef = useRef(false);

  const clearPolling = useCallback(() => {
    pollTokenRef.current += 1;
    pollInFlightRef.current = false;
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const pollStatus = useCallback(async (jobId: string, pollToken: number): Promise<boolean> => {
    if (finishedRef.current || pollToken !== pollTokenRef.current) return true;

    try {
      const data = await fetchJson<VideoStatusResponse>(`/api/generate/video/${jobId}/status`);
      if (pollToken !== pollTokenRef.current) return true;

      if (data.status === "SUCCEEDED") {
        finishedRef.current = true;
        setState((prev) => ({
          ...prev,
          status: "succeeded",
          asset: data.asset ?? null,
          error: null,
          errorKind: null,
          pollFailCount: 0,
        }));
        return true;
      }

      if (data.status === "FAILED") {
        finishedRef.current = true;
        setState((prev) => ({
          ...prev,
          status: "failed",
          error: data.error ?? "Video generation failed",
          errorKind: "job_failed",
        }));
        return true;
      }

      // Successful RUNNING poll: reset the consecutive-error counter so the
      // network may glitch a few times without poisoning the whole job.
      setState((prev) => (prev.pollFailCount === 0 ? prev : { ...prev, pollFailCount: 0 }));
      return false;
    } catch (error) {
      if (pollToken !== pollTokenRef.current) return true;
      const kind = classifyPollError(error);
      if (kind === "client_4xx") {
        finishedRef.current = true;
        setState((prev) => ({
          ...prev,
          status: "failed",
          error: "Video job not found",
          errorKind: "client_4xx",
        }));
        return true;
      }

      let done = false;
      setState((prev) => {
        const nextCount = prev.pollFailCount + 1;
        if (nextCount >= MAX_POLL_ERRORS) {
          done = true;
          return {
            ...prev,
            status: "failed",
            error: "Connection lost. Check your network.",
            errorKind: kind,
            pollFailCount: nextCount,
          };
        }
        return { ...prev, pollFailCount: nextCount };
      });
      if (done) finishedRef.current = true;
      return done;
    }
  }, []);

  const startPolling = useCallback(
    (jobId: string) => {
      clearPolling();
      finishedRef.current = false;
      const pollToken = pollTokenRef.current += 1;
      intervalRef.current = setInterval(async () => {
        if (finishedRef.current) {
          clearPolling();
          return;
        }
        if (pollInFlightRef.current) return;
        pollInFlightRef.current = true;
        try {
          const done = await pollStatus(jobId, pollToken);
          if (done && pollToken === pollTokenRef.current) clearPolling();
        } finally {
          if (pollToken === pollTokenRef.current) {
            pollInFlightRef.current = false;
          }
        }
      }, POLL_INTERVAL);
    },
    [pollStatus, clearPolling],
  );

  const submit = useCallback(
    async (params: SubmitParams): Promise<boolean> => {
      clearPolling();
      finishedRef.current = false;
      setState({
        status: "submitting",
        jobId: null,
        asset: null,
        error: null,
        errorKind: null,
        pollFailCount: 0,
      });

      try {
        const formData = new FormData();
        formData.append("prompt", params.prompt);
        formData.append("modelId", params.modelId);
        formData.append("duration", String(params.duration));
        formData.append("idempotencyKey", crypto.randomUUID());
        if (params.projectId) formData.append("projectId", params.projectId);
        if (params.referenceImage)
          formData.append("referenceImage", params.referenceImage);

        const data = await fetchJson<VideoCreateResponse>(
          "/api/generate/video",
          {
            method: "POST",
            body: formData,
          },
        );

        setState((prev) => ({
          ...prev,
          status: "running",
          jobId: data.jobId,
          error: null,
          errorKind: null,
        }));

        startPolling(data.jobId);
        return true;
      } catch (error) {
        finishedRef.current = true;
        setState((prev) => ({
          ...prev,
          status: "failed",
          error: toErrorMessage(error, "Failed to start video generation"),
          errorKind: "submit_failed",
        }));
        return false;
      }
    },
    [startPolling, clearPolling],
  );

  const reset = useCallback(() => {
    clearPolling();
    finishedRef.current = false;
    setState(INITIAL_STATE);
  }, [clearPolling]);

  useEffect(() => () => {
    clearPolling();
  }, [clearPolling]);

  return { ...state, submit, reset };
}
