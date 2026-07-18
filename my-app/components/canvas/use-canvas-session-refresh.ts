"use client";

/**
 * use-canvas-session-refresh — agent-driven inbound sync for the canvas stage.
 *
 * Why polling (not SSE / custom event):
 *   - Agent v2 finishes by writing to Prisma (`canvasSession.updatedAt`,
 *     new CanvasLayer rows). There is no existing SSE channel from agent → UI.
 *   - A lightweight revision probe checks the parent timestamp plus layer
 *     count/latest timestamp; the full payload is fetched only after a change.
 *   - We gate on `document.visibilityState === "visible"` so a backgrounded
 *     tab doesn't burn requests; refresh fires immediately on tab return.
 *
 * The hook stays unopinionated about merging — it hands the latest session
 * payload back to the caller. Conflict resolution against in-flight user
 * edits is handled by the active canvas stage.
 */
import { useEffect, useRef } from "react";
import type {
  CanvasRawLayer,
  CanvasSessionResponse,
} from "@/lib/client/canvas-sessions";

export interface UseCanvasSessionRefreshArgs {
  sessionId: string;
  /** When false, the hook is dormant — used to pause during initial load. */
  enabled?: boolean;
  /** Poll interval in ms. Default 3000. */
  intervalMs?: number;
  /** Called with the freshly-fetched layer set whenever it changes. */
  onLayers: (layers: CanvasRawLayer[]) => void;
  /** Called with the full session payload when any render-relevant field changes. */
  onSession?: (session: CanvasSessionResponse["session"]) => void;
}

export function buildCanvasSessionRefreshSignature(session: CanvasSessionResponse["session"]): string {
  const layerSig = (session.layers ?? [])
    .map(
      (l) =>
        `${l.id}:${l.assetId}:${l.x}:${l.y}:${l.width}:${l.height}:${l.rotation ?? 0}:${l.zIndex}:${l.hidden ? 1 : 0}:${l.locked ? 1 : 0}`,
    )
    .join("|");
  return `${session.updatedAt ?? ""}|${layerSig}`;
}

interface CanvasSessionRefreshProbe {
  revision: string;
  session?: CanvasSessionResponse["session"];
}

interface CanvasSessionRefreshController {
  start: () => void;
  requestRefresh: () => void;
  stop: () => void;
}

async function fetchRefreshJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Canvas refresh failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export async function probeCanvasSessionRefresh(
  sessionId: string,
  lastRevision: string | null,
  signal: AbortSignal,
): Promise<CanvasSessionRefreshProbe> {
  const base = `/api/canvas/sessions/${encodeURIComponent(sessionId)}`;
  const revisionPayload = await fetchRefreshJson<{ revision?: unknown }>(
    `${base}/revision`,
    signal,
  );
  if (typeof revisionPayload.revision !== "string" || !revisionPayload.revision) {
    throw new Error("Canvas revision response is invalid.");
  }
  if (revisionPayload.revision === lastRevision) {
    return { revision: revisionPayload.revision };
  }

  const full = await fetchRefreshJson<CanvasSessionResponse>(base, signal);
  return {
    // The endpoint revision is composite (session + layer signals). Never
    // replace it with the parent session timestamp from the full payload, or
    // the next probe would compare unlike values and fetch forever.
    revision: revisionPayload.revision,
    session: full.session,
  };
}

export function createCanvasSessionRefreshController({
  sessionId,
  intervalMs,
  isVisible,
  onChanged,
  probe = probeCanvasSessionRefresh,
}: {
  sessionId: string;
  intervalMs: number;
  isVisible: () => boolean;
  onChanged: (session: CanvasSessionResponse["session"]) => void;
  probe?: typeof probeCanvasSessionRefresh;
}): CanvasSessionRefreshController {
  let stopped = false;
  let running = false;
  let refreshQueued = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRevision: string | null = null;
  const abortController = new AbortController();

  const schedule = () => {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, intervalMs);
  };

  const tick = async () => {
    if (stopped) return;
    if (!isVisible()) {
      schedule();
      return;
    }
    if (running) {
      refreshQueued = true;
      return;
    }
    running = true;
    try {
      const result = await probe(sessionId, lastRevision, abortController.signal);
      if (stopped) return;
      lastRevision = result.revision;
      if (result.session) onChanged(result.session);
    } catch {
      if (abortController.signal.aborted) return;
      // Transient failures retry on the next scheduled probe.
    } finally {
      running = false;
      if (stopped) return;
      if (refreshQueued) {
        refreshQueued = false;
        void tick();
      } else {
        schedule();
      }
    }
  };

  return {
    start: schedule,
    requestRefresh() {
      if (stopped) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (running) {
        refreshQueued = true;
      } else {
        void tick();
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      abortController.abort();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export function useCanvasSessionRefresh({
  sessionId,
  enabled = true,
  intervalMs = 3000,
  onLayers,
  onSession,
}: UseCanvasSessionRefreshArgs): void {
  // Latest `onLayers` without re-arming the interval each render.
  const onLayersRef = useRef(onLayers);
  const onSessionRef = useRef(onSession);
  useEffect(() => {
    onLayersRef.current = onLayers;
  }, [onLayers]);
  useEffect(() => {
    onSessionRef.current = onSession;
  }, [onSession]);

  useEffect(() => {
    if (!enabled || !sessionId) return;

    let lastSignature = "";
    const controller = createCanvasSessionRefreshController({
      sessionId,
      intervalMs,
      isVisible: () => document.visibilityState === "visible",
      onChanged(session) {
        const layers = session.layers ?? [];
        // Signature only captures fields the stage actually renders — avoids
        // pointless re-emits on cosmetic backend changes.
        const sig = buildCanvasSessionRefreshSignature({ ...session, layers });
        if (sig === lastSignature) return;
        lastSignature = sig;
        onSessionRef.current?.(session);
        onLayersRef.current(layers);
      },
    });

    controller.start();

    // Immediate refresh when tab returns to foreground.
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      controller.requestRefresh();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      controller.stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sessionId, enabled, intervalMs]);
}
