"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DOWNLOAD_PROGRESS_INITIAL_STATE,
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
  const canceledRef = useRef(false);
  const currentJobIdRef = useRef<string | null>(null);

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
          resolve(status);
        };

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
          setProgress(reduced.progress);

          if (reduced.terminalStatus) finish(reduced.terminalStatus);
        };

        source.onerror = () => {
          if (canceledRef.current) {
            finish("canceled");
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
    [stopStream],
  );

  /**
   * Start downloading a model by catalog id. Single-file kits behave exactly
   * as before; multi-file kits fetch each file sequentially.
   */
  const start = useCallback(
    async (modelId: string) => {
      canceledRef.current = false;
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
        if (canceledRef.current) {
          setProgress((prev) => ({ ...prev, status: "canceled" }));
          return;
        }
        const f = kit.files[i]!; // safe: i < kit.files.length loop bound guarantees presence
        try {
          const response = await fetch("/api/desktop-runtime/hf-download", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(kit.multi ? { modelId, file: f.name } : { modelId }),
            cache: "no-store",
          });
          if (!response.ok) {
            const text = await response.text();
            setProgress((prev) => ({
              ...prev,
              status: "error",
              error: `Failed to start download: ${text}`,
            }));
            return;
          }
          const { jobId } = (await response.json()) as { jobId: string };
          currentJobIdRef.current = jobId;
          setProgress((prev) => ({
            ...prev,
            jobId,
            status: "downloading",
            fileIndex: i,
          }));
          const outcome = await streamOne(jobId, completedBytes, i, kit);
          if (outcome !== "ready") {
            // streamOne already set the terminal status (error/canceled).
            if (outcome === "canceled") {
              setProgress((prev) => ({ ...prev, status: "canceled" }));
            }
            return;
          }
          completedBytes += f.size;
        } catch (err) {
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
    [stopStream, streamOne],
  );

  /** Cancel the in-flight kit: abort the current stream + DELETE its job. */
  const cancel = useCallback(async () => {
    canceledRef.current = true;
    const jobId = currentJobIdRef.current;
    stopStream();
    setProgress((prev) => ({ ...prev, status: "canceled" }));
    if (jobId) {
      try {
        await fetch(`/api/desktop-runtime/hf-download/${encodeURIComponent(jobId)}`, {
          method: "DELETE",
          cache: "no-store",
        });
      } catch {
        // Non-fatal — the cancel flag is also set on the bridge side.
      }
    }
  }, [stopStream]);

  return {
    ...progress,
    start,
    cancel,
  };
}
