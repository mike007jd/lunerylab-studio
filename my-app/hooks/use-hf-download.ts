"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DOWNLOAD_PROGRESS_INITIAL_STATE,
  HfDownloadCancelCoordinator,
  normalizeDownloadStatus,
  reduceBridgeDownloadSnapshot,
  resolveHfDownloadKit,
  type BridgeDownloadSnapshot,
  type DownloadSpeedSample,
  type HfDownloadKit,
} from "@/lib/client/hf-download-progress";

// ---------------------------------------------------------------------------
// Hook
//
// The browser reads progress through EventSource, the platform SSE client for
// `text/event-stream`. The Next route owns bridge auth and exposes a same-origin
// stream, so the browser does not need custom EventSource headers.
// Multi-file kits download sequentially: one normal single-file resumable bridge
// job per file, aggregated into one DownloadProgress.
// ---------------------------------------------------------------------------

export function useHfDownload() {
  const [progress, setProgress] = useState(DOWNLOAD_PROGRESS_INITIAL_STATE);
  const eventSourceRef = useRef<EventSource | null>(null);
  const cancelCoordinatorRef = useRef<HfDownloadCancelCoordinator | null>(null);
  const currentTerminalResolverRef = useRef<
    ((status: "ready" | "error" | "canceled") => void) | null
  >(null);
  if (!cancelCoordinatorRef.current) {
    cancelCoordinatorRef.current = new HfDownloadCancelCoordinator();
  }
  const cancelCoordinator = cancelCoordinatorRef.current;

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const stopStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  /**
   * Stream one file's SSE progress. Resolves with the terminal status
   * ("ready" | "error" | "canceled"). Updates aggregate progress live:
   * aggregate received = completedBytes + this file's received.
   */
  const streamOne = useCallback(
    (
      jobId: string,
      completedBytes: number,
      fileIndex: number,
      kit: HfDownloadKit,
    ): Promise<"ready" | "error" | "canceled"> => {
      stopStream();

      let speedSample: DownloadSpeedSample | null = null;

      return new Promise<"ready" | "error" | "canceled">((resolve) => {
        const source = new EventSource(
          `/api/desktop-runtime/hf-download/${encodeURIComponent(jobId)}/progress`,
        );
        eventSourceRef.current = source;
        let settled = false;
        const finish = (status: "ready" | "error" | "canceled") => {
          if (settled) return;
          settled = true;
          source.close();
          if (eventSourceRef.current === source) eventSourceRef.current = null;
          if (currentTerminalResolverRef.current === finish) {
            currentTerminalResolverRef.current = null;
          }
          resolve(status);
        };
        currentTerminalResolverRef.current = finish;

        source.onmessage = (event) => {
          let snapshot: BridgeDownloadSnapshot;
          try {
            snapshot = JSON.parse(event.data) as BridgeDownloadSnapshot;
          } catch {
            return;
          }

          const reduced = reduceBridgeDownloadSnapshot({
            snapshot,
            previousSpeedSample: speedSample,
            completedBytes,
            fileIndex,
            jobId,
            kit,
            timestamp: Date.now(),
          });
          speedSample = reduced.speedSample;
          setProgress((previous) =>
            cancelCoordinator.cancelRequested && !reduced.terminalStatus
              ? {
                  ...reduced.progress,
                  status: previous.status === "queued" ? "queued" : "downloading",
                  error: previous.error,
                }
              : reduced.progress,
          );

          if (reduced.terminalStatus) finish(reduced.terminalStatus);
        };

        source.onerror = () => {
          if (cancelCoordinator.cancelRequested) {
            // Cancel intent is not terminal truth. The cancel coordinator keeps
            // polling GET until the bridge reports ready/error/canceled.
            return;
          }
          setProgress((prev) => ({
            ...prev,
            status: "error",
            error: "Progress stream failed.",
          }));
          finish("error");
        };
      });
    },
    [cancelCoordinator, stopStream],
  );

  /**
   * Start downloading a model by catalog id. Single-file kits behave exactly
   * as before; multi-file kits fetch each file sequentially.
   */
  const start = useCallback(
    async (modelId: string) => {
      cancelCoordinator.resetForStart();
      const kit = resolveHfDownloadKit(modelId);
      setProgress({
        ...DOWNLOAD_PROGRESS_INITIAL_STATE,
        status: "queued",
        total: kit.total,
        fileCount: kit.files.length,
      });
      stopStream();

      let completedBytes = 0;
      for (let i = 0; i < kit.files.length; i += 1) {
        if (!cancelCoordinator.prepareJobRequest()) return;
        const f = kit.files[i]!; // safe: i < kit.files.length loop bound guarantees presence
        try {
          const response = await fetch("/api/desktop-runtime/hf-download", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(kit.multi ? { modelId, file: f.name } : { modelId }),
            cache: "no-store",
          });
          if (!response.ok) {
            cancelCoordinator.failJobRequest();
            const text = await response.text();
            setProgress((prev) => ({
              ...prev,
              status: "error",
              error: `Failed to start download: ${text}`,
            }));
            return;
          }
          const { jobId } = (await response.json()) as { jobId: string };
          cancelCoordinator.registerJob(jobId);
          const pendingCancel = cancelCoordinator.activeCancelAttempt();
          if (pendingCancel) {
            try {
              await pendingCancel;
              return;
            } catch {
              // Cancel was rejected or transport failed; keep watching the
              // still-active server job and allow a retry.
            }
          }
          setProgress((prev) => ({
            ...prev,
            jobId,
            status: "downloading",
            fileIndex: i,
          }));
          const outcome = await streamOne(jobId, completedBytes, i, kit);
          cancelCoordinator.finishJob(jobId);
          if (outcome !== "ready") {
            // streamOne already set the terminal status (error/canceled).
            if (outcome === "canceled") {
              setProgress((prev) => ({ ...prev, status: "canceled" }));
            }
            return;
          }
          completedBytes += f.size;
        } catch (err) {
          cancelCoordinator.failJobRequest();
          setProgress((prev) => ({
            ...prev,
            status: "error",
            error: err instanceof Error ? err.message : "Could not start download",
          }));
          return;
        }
      }

      setProgress((prev) => ({
        ...prev,
        status: "ready",
        percent: kit.total > 0 ? 100 : prev.percent,
        received: kit.total,
        total: kit.total,
        speedBps: 0,
      }));
    },
    [cancelCoordinator, stopStream, streamOne],
  );

  /** Cancel the in-flight kit and wait for a server-reported terminal state. */
  const cancel = useCallback(async () => {
    try {
      const outcome = await cancelCoordinator.requestCancel();
      const snapshot = outcome.snapshot;
      setProgress((previous) => ({
        ...previous,
        status: outcome.status,
        received: snapshot?.received ?? previous.received,
        total: snapshot?.total ?? previous.total,
        error: snapshot?.error ?? null,
        speedBps: 0,
      }));
      currentTerminalResolverRef.current?.(outcome.status);
      stopStream();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cancel request failed.";
      setProgress((previous) => ({
        ...previous,
        // Preserve queued/downloading instead of claiming terminal canceled.
        status: normalizeDownloadStatus(previous.status),
        error: message,
      }));
      throw error;
    }
  }, [cancelCoordinator, stopStream]);

  return {
    ...progress,
    start,
    cancel,
  };
}
