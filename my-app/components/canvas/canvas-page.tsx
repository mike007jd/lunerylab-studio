"use client";

/** Canvas workspace: persisted Konva asset stage, editing tools, and Luna. */

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { KonvaStageHandle, KonvaLayerItem } from "@/components/canvas/konva-stage";
import type { CanvasDrawingState } from "@/lib/canvas/drawing-state";
import { useCanvasSessionRefresh } from "@/components/canvas/use-canvas-session-refresh";
import {
  createLatestWriteQueue,
  type LatestWriteQueue,
} from "@/components/canvas/latest-write-queue";
import { hasFalImageEditBackend } from "@/components/canvas/image-edit-capability";
import {
  bindUnsavedCanvasGuard,
  canClearDirtyGeometry,
  canReportCanvasSaved,
  canUseDrawingStateKeepalive,
  deferDrawingQueueDisposal,
  findServerDeletedDirtyLayerIds,
  mergePolledLayers,
} from "@/components/canvas/drawing-state-lifecycle";
import { CanvasRouteState } from "@/components/canvas/canvas-route-state";
import { CanvasExportPopover } from "@/components/canvas/canvas-export-popover";
import { COPY } from "@/components/canvas/canvas-copy";
import {
  PATCH_DEBOUNCE_MS,
  PATCH_MAX_RETRIES,
  mapLayers,
} from "@/components/canvas/canvas-types";
import type {
  LayerGeometryPatch,
  RawLayer,
  SessionResponse,
} from "@/components/canvas/canvas-types";
import {
  deleteCanvasLayer,
  fetchCanvasSession,
  patchCanvasLayer,
} from "@/lib/client/canvas-sessions";
import { AgentChatPanel } from "@/components/studio/agent-chat-panel";
import { useAgentChat } from "@/components/studio/agent-chat/use-agent-chat";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowLeft, Check, Loader2, Sparkles, Wand2, X } from "@/components/ui/icons";
import { Textarea } from "@/components/ui/textarea";
import {
  resolveSelectableImageModelId,
  useModelCatalog,
} from "@/lib/client/use-model-catalog";
import { useSharedBootstrapSnapshot } from "@/lib/client/bootstrap-snapshot-provider";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import { useCreativeCapabilityReadiness } from "@/hooks/use-creative-capability-readiness";
import { resolveCanvasReturnTarget } from "@/lib/client/creation-flow";
import { fetchJson, toErrorMessage } from "@/lib/client/fetch-json";

interface CanvasExportResponse {
  exports: Array<{
    id: string;
    url: string;
    presetId: string;
    downloadName: string;
  }>;
}

function downloadCanvasExports(exports: CanvasExportResponse["exports"]): void {
  for (const item of exports) {
    const anchor = document.createElement("a");
    anchor.href = item.url;
    anchor.download = item.downloadName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
}

function CanvasStageLoading() {
  const { locale } = useI18n();
  const copy = COPY[locale] ?? COPY.en;

  return (
    <CanvasRouteState
      title={copy.openingTitle}
      description={copy.openingDescription}
    />
  );
}

// Konva is browser-only; load it on the client. We pass the imperative
// handle as a `stageRef` prop because next/dynamic strips React refs.
const KonvaStage = dynamic(
  () => import("@/components/canvas/konva-stage").then((m) => m.KonvaStage),
  {
    ssr: false,
    loading: CanvasStageLoading,
  },
);

interface DrawingStateWrite {
  state: CanvasDrawingState;
  epoch: number;
}

interface LayerPatchWrite {
  patch: LayerGeometryPatch;
}

const CANVAS_WRITE_TIMEOUT_MS = 5_000;

export function CanvasPage({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { locale } = useI18n();
  const copy = COPY[locale] ?? COPY.en;
  const readiness = useCreativeCapabilityReadiness();
  const bootstrap = useSharedBootstrapSnapshot();
  const returnTarget = resolveCanvasReturnTarget(searchParams.get("source"));
  const returnLabel = returnTarget.label === "studio"
    ? "Studio"
    : returnTarget.label === "projects"
      ? copy.projects
      : copy.library;
  const canvasCapabilityIssue = readiness.byId.imageGeneration;
  // Reliable "an image-generation backend is connected" signal — same source
  // the Studio surface uses to gate generation. Both canvas edit actions
  // (inpaint / remove-bg) run image-generation agent tools, so this is the
  // correct backend to require.
  const { imageModels, defaultImageModelId } = useModelCatalog();
  const activeImageModelId = resolveSelectableImageModelId(
    imageModels,
    defaultImageModelId,
    defaultImageModelId,
  );
  const hasImageBackend = Boolean(activeImageModelId);
  const hasFalImageEditing = hasFalImageEditBackend(imageModels);

  const [layers, setLayers] = useState<KonvaLayerItem[]>([]);
  const [drawingState, setDrawingState] = useState<CanvasDrawingState | undefined>();
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  // Re-key session loading for retry without a full document reload.
  const [reloadToken, setReloadToken] = useState(0);
  const [exitPending, setExitPending] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const exitPendingRef = useRef(false);

  const stageRef = useRef<KonvaStageHandle | null>(null);

  // Prevent inbound refreshes from clobbering annotations until the newest
  // local drawing state has actually reached storage.
  const drawingStateDirtyRef = useRef(false);
  const drawingStateEpochRef = useRef(0);
  const dirtyGeometryLayersRef = useRef<Set<string>>(new Set());
  const geometrySaveFailuresRef = useRef<Set<string>>(new Set());
  const pendingCreatedLayerIdsRef = useRef<Set<string>>(new Set());
  const pendingDeletedLayerIdsRef = useRef<Set<string>>(new Set());

  // Reflect debounced geometry and drawing-state writes without shifting layout.
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const inFlightSavesRef = useRef(0);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markSavePending = useCallback(() => {
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    setSaveStatus("saving");
  }, []);
  const beginSave = useCallback(() => {
    inFlightSavesRef.current += 1;
    markSavePending();
  }, [markSavePending]);
  const endSave = useCallback(() => {
    inFlightSavesRef.current = Math.max(0, inFlightSavesRef.current - 1);
    if (inFlightSavesRef.current === 0) {
      // Failed or merely debounced writes remain dirty and must never produce
      // a false positive "Saved" badge. Only the newest successful write for
      // every persistence channel clears its dirty marker.
      if (!canReportCanvasSaved({
        inFlightWrites: inFlightSavesRef.current,
        drawingStateDirty: drawingStateDirtyRef.current,
        dirtyGeometryLayers: dirtyGeometryLayersRef.current.size,
      })) {
        setSaveStatus("idle");
        return;
      }
      setSaveStatus("saved");
      savedTimerRef.current = setTimeout(() => {
        savedTimerRef.current = null;
        setSaveStatus("idle");
      }, 1800);
    }
  }, []);
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  useEffect(
    () =>
      bindUnsavedCanvasGuard({
        windowTarget: window,
        isDirty: () =>
          drawingStateDirtyRef.current ||
          dirtyGeometryLayersRef.current.size > 0 ||
          inFlightSavesRef.current > 0,
      }),
    [],
  );

  // Latest localized copy for callbacks whose deps stay [sessionId] (re-running
  // on locale change would refetch / churn). Read .current at call time. Updated
  // in an effect (not during render) so the refs-during-render lint stays happy;
  // `copy` only changes identity on a locale switch, so this is effectively idle.
  const copyRef = useRef(copy);
  useEffect(() => {
    copyRef.current = copy;
  }, [copy]);

  // One serialized writer owns drawingState persistence. While a request is in
  // flight, repeated edits collapse to the newest state; an older response can
  // therefore never land after and overwrite a newer one.
  const drawingStateSaveQueueRef = useRef<LatestWriteQueue<DrawingStateWrite> | null>(null);
  useEffect(() => {
    const queue = createLatestWriteQueue<DrawingStateWrite>({
      write: async ({ state }, signal) => {
        const body = JSON.stringify({ drawingState: state });
        const response = await fetch(
          `/api/canvas/sessions/${encodeURIComponent(sessionId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body,
            signal,
            // Browser keepalive is limited to small bodies. Oversized snapshots
            // use the normal queue; explicit exits await it and window teardown
            // is blocked while the latest state remains dirty.
            keepalive: canUseDrawingStateKeepalive(body),
          },
        );
        if (!response.ok) throw new Error(`status ${response.status}`);
      },
      maxRetries: PATCH_MAX_RETRIES,
      retryDelayMs: (attempt) => PATCH_DEBOUNCE_MS * Math.min(attempt + 1, 5),
      writeTimeoutMs: CANVAS_WRITE_TIMEOUT_MS,
      onStart: beginSave,
      onSettled: endSave,
      onLatestSaved: ({ epoch }) => {
        // A canvas edit may already be waiting inside the stage's debounce and
        // therefore not be visible to the network queue yet.
        if (drawingStateEpochRef.current === epoch) {
          drawingStateDirtyRef.current = false;
        }
      },
      onExhausted: () => {
        toast.error(copyRef.current.toastSaveFailed);
      },
    });
    drawingStateSaveQueueRef.current = queue;
    return () => {
      deferDrawingQueueDisposal(() => {
        queue.close();
        if (drawingStateSaveQueueRef.current === queue) {
          drawingStateSaveQueueRef.current = null;
        }
      });
    };
  }, [sessionId, beginSave, endSave]);

  // Per-layer debounced geometry persistence. A single drag/resize emits a
  // stream of geometry changes; the old handler fired an immediate PATCH for
  // each one, which could blow past the 60-req/min CRUD limit — and because it
  // ignored the response, 429s/validation failures were swallowed and the
  // optimistic canvas silently diverged from storage. We now coalesce to the
  // latest patch per layer, flush after a short idle, check response.ok, and
  // retry with backoff, surfacing a single error toast (not one per write) so
  // layout changes are never lost silently.
  const pendingPatchesRef = useRef<Map<string, LayerGeometryPatch>>(new Map());
  const patchTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const layerPatchQueuesRef = useRef<Map<string, LatestWriteQueue<LayerPatchWrite>>>(new Map());
  // Holds the latest flush implementation so the stable scheduler can call it
  // without a useCallback dependency cycle.
  const flushLayerPatchRef = useRef<((layerId: string) => void) | undefined>(undefined);

  // Agent chat — message state + SSE streaming + abort all live in useAgentChat
  // now (assistant-ui ExternalStoreRuntime is fed from it inside AgentChatPanel).
  // This page only owns the dock open/closed flag and bridges canvas actions
  // (inpaint / remove-bg) into the chat via the stable sendMessage.
  const [chatOpen, setChatOpen] = useState(false);
  const chat = useAgentChat({
    sessionId,
    selectedLayerId,
    selectedModelId: activeImageModelId,
    selectedTextModelId: bootstrap?.app.defaultTextModel ?? "",
    generationMode: "image",
  });
  const sendChatMessage = chat.sendMessage;

  // Chat history outlives the layers it produced. Both the availability probe
  // and the focus action resolve against current layers, so a deleted layer's
  // thumbnail is marked unavailable rather than silently missing on click.
  const isAssetAvailable = useCallback(
    (assetId: string) => layers.some((layer) => layer.assetId === assetId),
    [layers],
  );

  // Click a generated thumbnail in the chat → select that asset's layer.
  const handleFocusAsset = useCallback(
    (assetId: string) => {
      const layer = layers.find((l) => l.assetId === assetId);
      if (!layer) {
        toast.error(copyRef.current.toastAssetNotOnCanvas);
        return;
      }
      setSelectedLayerId(layer.id);
    },
    [layers],
  );

  // In-canvas text prompt — replaces the native window.prompt (no styling, no
  // focus management, blocks the main thread). `askText` opens a controlled
  // shadcn Dialog and resolves with the trimmed value on confirm, or null on
  // cancel / dismiss. One dialog instance is reused; concurrent calls are not
  // expected (each is awaited from a user-gated button handler).
  const [promptState, setPromptState] = useState<{
    open: boolean;
    title: string;
    placeholder: string;
    defaultValue: string;
    required: boolean;
    resolve: ((value: string | null) => void) | null;
  }>({
    open: false,
    title: "",
    placeholder: "",
    defaultValue: "",
    required: false,
    resolve: null,
  });
  const [promptValue, setPromptValue] = useState("");
  // Callback ref instead of a forwardRef on the shadcn Textarea (which is a
  // plain function component and would drop a passed ref). We focus + select
  // the element via this ref when the dialog opens.
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);

  const askText = useCallback(
    (opts: {
      title: string;
      placeholder?: string;
      defaultValue?: string;
      required?: boolean;
    }): Promise<string | null> =>
      new Promise((resolve) => {
        setPromptValue(opts.defaultValue ?? "");
        setPromptState({
          open: true,
          title: opts.title,
          placeholder: opts.placeholder ?? "",
          defaultValue: opts.defaultValue ?? "",
          required: opts.required ?? false,
          resolve,
        });
      }),
    [],
  );

  const closePrompt = useCallback(
    (value: string | null) => {
      promptState.resolve?.(value);
      setPromptState((prev) => ({ ...prev, open: false, resolve: null }));
    },
    [promptState],
  );

  const confirmPrompt = useCallback(() => {
    const trimmed = promptValue.trim();
    if (promptState.required && !trimmed) return; // required + empty → no-op
    closePrompt(trimmed);
  }, [promptValue, promptState.required, closePrompt]);

  // Focus the input when the dialog opens (Radix focuses DialogContent by
  // default; we want the caret in the field).
  useEffect(() => {
    if (!promptState.open) return;
    const id = window.setTimeout(() => {
      promptInputRef.current?.focus();
      promptInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [promptState.open]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const json = await fetchCanvasSession(sessionId);
        if (cancelled) return;
        setLayers(mapLayers(json.session.layers));
        setDrawingState(json.session.drawingState);
      } catch (err) {
        if (!cancelled) setError((err as Error).message || copyRef.current.loadFailedFallback);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadToken]);

  // Retry the session fetch without reloading the document.
  const handleRetry = useCallback(() => {
    setError(null);
    setLoading(true);
    setReloadToken((n) => n + 1);
  }, []);

  const shouldPollSession = !loading && !error && (chatOpen || chat.isRunning);

  // Agent-driven inbound refresh (poll-on-visible). The stage's lastSyncedRef
  // takes care of not stomping on the user's in-flight drag.
  useCanvasSessionRefresh({
    sessionId,
    enabled: shouldPollSession,
    intervalMs: chat.isRunning ? 3000 : 8000,
    onLayers: useCallback((next: RawLayer[]) => {
      const incoming = mapLayers(next);
      const incomingIds = new Set(incoming.map((layer) => layer.id));
      const pendingCreatedIds = pendingCreatedLayerIdsRef.current;
      const pendingDeletedIds = pendingDeletedLayerIdsRef.current;

      for (const id of pendingCreatedIds) {
        if (incomingIds.has(id)) pendingCreatedIds.delete(id);
      }
      for (const id of pendingDeletedIds) {
        if (!incomingIds.has(id)) pendingDeletedIds.delete(id);
      }

      const serverDeletedDirtyIds = findServerDeletedDirtyLayerIds(
        incoming,
        dirtyGeometryLayersRef.current,
        pendingCreatedIds,
      );
      for (const layerId of serverDeletedDirtyIds) {
        const timer = patchTimersRef.current.get(layerId);
        if (timer) clearTimeout(timer);
        patchTimersRef.current.delete(layerId);
        pendingPatchesRef.current.delete(layerId);
        dirtyGeometryLayersRef.current.delete(layerId);
        geometrySaveFailuresRef.current.delete(layerId);
        layerPatchQueuesRef.current.get(layerId)?.close();
        layerPatchQueuesRef.current.delete(layerId);
      }
      if (serverDeletedDirtyIds.length > 0) {
        const deleted = new Set(serverDeletedDirtyIds);
        setSelectedLayerId((current) => current && deleted.has(current) ? null : current);
      }

      const dirtyIds = new Set(dirtyGeometryLayersRef.current);
      const preserveMissingIds = new Set(pendingCreatedIds);
      const deletedIds = new Set(pendingDeletedIds);
      setLayers((current) =>
        mergePolledLayers(current, incoming, dirtyIds, {
          preserveMissingIds,
          deletedIds,
        }),
      );
    }, []),
    onSession: useCallback((session: SessionResponse["session"]) => {
      // Skip the inbound snapshot while local annotations are unsaved, or it
      // would silently delete them (H1). The next successful PATCH clears dirty
      // and the following poll syncs normally.
      if (drawingStateDirtyRef.current) return;
      setDrawingState(session.drawingState);
    }, []),
  });

  const getLayerPatchQueue = useCallback((layerId: string) => {
    const existing = layerPatchQueuesRef.current.get(layerId);
    if (existing) return existing;

    const queue = createLatestWriteQueue<LayerPatchWrite>({
      write: ({ patch }, signal) => patchCanvasLayer(sessionId, layerId, patch, signal),
      // Geometry updates are partial. If x fails while a newer y is queued,
      // the retry must carry both fields (with the newer value winning) or the
      // failed field is silently lost.
      mergePending: (older, newer) => ({
        patch: { ...older.patch, ...newer.patch },
      }),
      maxRetries: PATCH_MAX_RETRIES,
      retryDelayMs: (attempt) => PATCH_DEBOUNCE_MS * Math.min(attempt + 1, 5),
      writeTimeoutMs: CANVAS_WRITE_TIMEOUT_MS,
      onStart: beginSave,
      onSettled: endSave,
      onLatestSaved: () => {
        // A newer edit can still be waiting in the outer debounce even when
        // the queue itself has no pending value. Keep the layer dirty until
        // that newer patch also reaches storage.
        if (!canClearDirtyGeometry(pendingPatchesRef.current.has(layerId))) return;
        dirtyGeometryLayersRef.current.delete(layerId);
        geometrySaveFailuresRef.current.delete(layerId);
      },
      onExhausted: () => {
        const shouldNotify = geometrySaveFailuresRef.current.size === 0;
        geometrySaveFailuresRef.current.add(layerId);
        if (shouldNotify) toast.error(copyRef.current.toastSaveFailed);
      },
    });
    layerPatchQueuesRef.current.set(layerId, queue);
    return queue;
  }, [sessionId, beginSave, endSave]);

  const flushLayerPatch = useCallback((layerId: string) => {
    patchTimersRef.current.delete(layerId);
    const patch = pendingPatchesRef.current.get(layerId);
    pendingPatchesRef.current.delete(layerId);
    if (!patch || Object.keys(patch).length === 0) return;
    getLayerPatchQueue(layerId).enqueue({ patch });
  }, [getLayerPatchQueue]);

  useEffect(() => {
    flushLayerPatchRef.current = flushLayerPatch;
  }, [flushLayerPatch]);

  // Re-sync layer state from the server — used as the recovery path when an
  // optimistic delete fails (so the UI never drifts from storage).
  const resyncLayers = useCallback(async () => {
    try {
      const json = await fetchCanvasSession(sessionId);
      setLayers(mapLayers(json.session.layers));
    } catch {
      // Network still down — the save-failed toast already told the user.
    }
  }, [sessionId]);

  const flushAllCanvasWrites = useCallback(async (): Promise<boolean> => {
    stageRef.current?.flushDrawingState();
    for (const timer of patchTimersRef.current.values()) clearTimeout(timer);
    patchTimersRef.current.clear();
    for (const layerId of pendingPatchesRef.current.keys()) flushLayerPatch(layerId);
    pendingPatchesRef.current.clear();

    const queues = [
      ...(drawingStateSaveQueueRef.current ? [drawingStateSaveQueueRef.current] : []),
      ...layerPatchQueuesRef.current.values(),
    ];
    const outcomes = await Promise.all(queues.map((queue) => queue.flush()));
    return outcomes.every(Boolean) &&
      !drawingStateDirtyRef.current &&
      dirtyGeometryLayersRef.current.size === 0;
  }, [flushLayerPatch]);

  // In-app exits wait for the live canvas debounce and geometry queues. Actual
  // window teardown is separately guarded while any channel remains dirty.
  const handleExitToLibrary = useCallback(async () => {
    if (exitPendingRef.current) return;
    exitPendingRef.current = true;
    setExitPending(true);
    const saved = await flushAllCanvasWrites();
    if (!saved) {
      toast.error(copyRef.current.toastSaveFailed);
      exitPendingRef.current = false;
      setExitPending(false);
      return;
    }
    router.push(returnTarget.href);
  }, [flushAllCanvasWrites, returnTarget.href, router]);

  // User deleted an image layer inside the canvas — persist it so it doesn't
  // resurrect on reload. Optimistic: local state updates immediately, a
  // failed DELETE re-syncs from the server and tells the user.
  const handleDeleteLayer = useCallback((layerId: string) => {
    pendingCreatedLayerIdsRef.current.delete(layerId);
    pendingDeletedLayerIdsRef.current.add(layerId);
    const timer = patchTimersRef.current.get(layerId);
    if (timer) clearTimeout(timer);
    patchTimersRef.current.delete(layerId);
    pendingPatchesRef.current.delete(layerId);
    dirtyGeometryLayersRef.current.delete(layerId);
    geometrySaveFailuresRef.current.delete(layerId);
    layerPatchQueuesRef.current.get(layerId)?.close();
    layerPatchQueuesRef.current.delete(layerId);
    setLayers((prev) => prev.filter((layer) => layer.id !== layerId));
    setSelectedLayerId((prev) => (prev === layerId ? null : prev));
    void (async () => {
      try {
        const resp = await deleteCanvasLayer(sessionId, layerId);
        // 404 = already gone (agent/poll removed it first) — that's success.
        if (!resp.ok && resp.status !== 404) throw new Error(`status ${resp.status}`);
      } catch {
        pendingDeletedLayerIdsRef.current.delete(layerId);
        toast.error(copyRef.current.toastDeleteLayerFailed);
        void resyncLayers();
      }
    })();
  }, [sessionId, resyncLayers]);

  // Undo-of-delete / paste / duplicate re-materialised a layer shape without a
  // Debounced patch — coalesce a stream of drag events into a single PATCH per
  // layer. Stable identity (no deps): all mutable state lives in refs.
  const handlePatchLayer = useCallback(async (layerId: string, patch: LayerGeometryPatch) => {
    dirtyGeometryLayersRef.current.add(layerId);
    markSavePending();
    pendingPatchesRef.current.set(layerId, {
      ...pendingPatchesRef.current.get(layerId),
      ...patch,
    });
    const existing = patchTimersRef.current.get(layerId);
    if (existing) clearTimeout(existing);
    patchTimersRef.current.set(
      layerId,
      setTimeout(() => void flushLayerPatchRef.current?.(layerId), PATCH_DEBOUNCE_MS),
    );
  }, [markSavePending]);

  // On unmount, flush any pending geometry so a quick navigate-away doesn't drop
  // the last move (keepalive lets the PATCH outlive the page), and clear timers
  // to avoid leaks / setState-after-unmount.
  useEffect(() => {
    const timers = patchTimersRef.current;
    const pending = pendingPatchesRef.current;
    const queues = layerPatchQueuesRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      // Enqueue through the same per-layer serial writer. A direct keepalive
      // request here could overtake an older in-flight PATCH and then be
      // overwritten by that older response.
      for (const layerId of pending.keys()) {
        flushLayerPatchRef.current?.(layerId);
      }
      pending.clear();
      for (const queue of queues.values()) queue.close();
      queues.clear();
    };
  }, [sessionId]);

  const handleDrawingStateChange = useCallback(
    (next: CanvasDrawingState) => {
      // Mark dirty before enqueueing so any poll firing during persistence
      // skips the inbound snapshot.
      drawingStateDirtyRef.current = true;
      setDrawingState(next);
      drawingStateSaveQueueRef.current?.enqueue({
        state: next,
        epoch: drawingStateEpochRef.current,
      });
    },
    [],
  );

  const handleDrawingStateDirty = useCallback(() => {
    drawingStateDirtyRef.current = true;
    drawingStateEpochRef.current += 1;
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    setSaveStatus("saving");
  }, []);

  // Inpaint the masked region: produce the b/w mask PNG via Konva export,
  // upload it as a temporary token, then dispatch a chat message so the agent's
  // `inpaint_layer` tool can run with the real pixel mask attached. The old
  // implementation downloaded the mask to disk — that left users with no path
  // forward; now the mask is the actual inpaint input.
  const handleInpaintHere = useCallback(async () => {
    if (chat.isRunning) return;
    if (!selectedLayerId) {
      toast.error(copy.toastSelectLayerToMask);
      return;
    }
    const handle = stageRef.current;
    if (!handle) return;
    const maskResult = await handle.getMaskForLayer(selectedLayerId);
    if (!maskResult.ok) {
      toast.error(
        maskResult.reason === "rotated-layer"
          ? copy.toastRotatedLayerMask
          : copy.toastNoMarkerShapes,
      );
      return;
    }
    const blob = maskResult.blob;
    const prompt = await askText({
      title: copy.promptInpaintTitle,
      placeholder: copy.promptInpaintPlaceholder,
      required: true,
    });
    if (!prompt || !prompt.trim()) return;

    // Upload the exact black/white mask through the canvas-temporary endpoint.
    // It returns no Library asset or GenerationJob; the token is consumed and
    // deleted by the image tool, with this client cleanup as a final backstop.
    let maskToken: string;
    try {
      const fd = new FormData();
      fd.append("file", blob, `mask-${selectedLayerId}.png`);
      const up = await fetch("/api/canvas/masks", { method: "POST", body: fd });
      if (!up.ok) {
        throw new Error(`Mask upload failed (${up.status}).`);
      }
      const json = (await up.json()) as { mask?: { token?: string } };
      if (!json.mask?.token) throw new Error("Mask upload returned no token.");
      maskToken = json.mask.token;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : copy.toastMaskUploadFailed);
      return;
    }

    const composed = `Inpaint layer ${selectedLayerId} using the uploaded mask. Replace the masked region with: ${prompt.trim()}.`;
    setChatOpen(true);
    try {
      await sendChatMessage(composed, {
        maskAssetId: maskToken,
        action: {
          type: "inpaint_layer",
          layerId: selectedLayerId,
          prompt: prompt.trim(),
        },
      });
    } finally {
      void fetch(`/api/canvas/masks/${encodeURIComponent(maskToken)}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {});
    }
  }, [selectedLayerId, askText, sendChatMessage, copy, chat.isRunning]);

  // Remove background — dispatches the agent's `remove_background` tool on
  // the currently-selected layer. No prompt, no mask. The agent replaces the
  // original layer with the cut-out result via reverse-sync.
  const handleRemoveBackground = useCallback(() => {
    if (chat.isRunning) return;
    if (!selectedLayerId) {
      toast.error(copy.toastSelectLayer);
      return;
    }
    setChatOpen(true);
    void sendChatMessage(
      `Remove the background of layer ${selectedLayerId}. Keep the main subject.`,
      {
        action: {
          type: "remove_background",
          layerId: selectedLayerId,
        },
      },
    );
  }, [selectedLayerId, sendChatMessage, copy, chat.isRunning]);

  const exportCanvas = useCallback(async (
    mode: "original" | "platforms",
    presetIds: string[] = [],
  ): Promise<boolean> => {
    if (exportBusy) return false;
    const composition = await stageRef.current?.exportComposition();
    if (!composition?.ok) {
      toast.error(composition?.reason === "empty" ? copy.exportEmptyTooltip : copy.exportUnavailable);
      return false;
    }
    setExportBusy(true);
    try {
      const formData = new FormData();
      formData.append("source", composition.blob, `canvas-${sessionId}.png`);
      formData.append("mode", mode);
      presetIds.forEach((presetId) => formData.append("presetIds", presetId));
      const response = await fetchJson<CanvasExportResponse>(
        `/api/canvas/sessions/${encodeURIComponent(sessionId)}/export`,
        { method: "POST", body: formData },
      );
      downloadCanvasExports(response.exports);
      toast.success(copy.exportComplete);
      return true;
    } catch (exportError) {
      toast.error(toErrorMessage(exportError, copy.exportFailed));
      return false;
    } finally {
      setExportBusy(false);
    }
  }, [copy, exportBusy, sessionId]);

  const handleExportOriginal = useCallback(
    () => exportCanvas("original"),
    [exportCanvas],
  );
  const handleExportPlatforms = useCallback(
    (presetIds: string[]) => exportCanvas("platforms", presetIds),
    [exportCanvas],
  );

  // These two tools currently have a Fal-only server implementation. Gate on
  // a connected Fal catalog row instead of any image model, which
  // would advertise actions that deterministically fail for local/OpenAI-only
  // setups.
  if (error) {
    return (
      <CanvasRouteState
        title={copy.loadFailedTitle}
        description={error}
        tone="danger"
      >
        <Button type="button" variant="accent" onClick={handleRetry}>
          {copy.retry}
        </Button>
        <Button type="button" variant="outline" loading={exitPending} onClick={handleExitToLibrary}>
          {returnLabel}
        </Button>
      </CanvasRouteState>
    );
  }
  if (loading) {
    return (
      <CanvasRouteState
        title={copy.openingTitle}
        description={copy.openingDescription}
      />
    );
  }

  return (
    <div className="fixed inset-0 bg-(--bg-base)">
      <KonvaStage
        sessionId={sessionId}
        stageRef={stageRef}
        layers={layers}
        drawingState={drawingState}
        selectedLayerId={selectedLayerId}
        onSelectLayer={setSelectedLayerId}
        onPatchLayer={handlePatchLayer}
        onDeleteLayer={handleDeleteLayer}
        onDrawingStateDirty={handleDrawingStateDirty}
        onDrawingStateChange={handleDrawingStateChange}
      />

      {/* Persistent exit — canvas chrome has no app navigation, so without this
          the canvas is a dead end once layers exist. Sits below the editor's top-left
          menu bar. */}
      <div className="pointer-events-none absolute left-2 top-12 z-(--z-overlay) flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="pointer-events-auto shadow-md"
          loading={exitPending}
          onClick={handleExitToLibrary}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {returnLabel}
        </Button>
        <div className="pointer-events-auto">
          <CanvasExportPopover
            disabled={!layers.some((layer) => !layer.hidden)}
            busy={exportBusy}
            isChinese={locale.startsWith("zh")}
            copy={copy}
            onExportOriginal={handleExportOriginal}
            onExportPlatforms={handleExportPlatforms}
          />
        </div>
        {/* Fixed width prevents save-status changes from shifting the toolbar. */}
        <div
          className="pointer-events-none flex h-7 items-center gap-1.5 rounded-md px-2 text-xs"
          style={{ minWidth: "5.5rem" }}
          aria-live="polite"
        >
          {saveStatus === "saving" ? (
            <span className="flex items-center gap-1.5 text-(--text-muted)">
              <Loader2 className="h-3 w-3 animate-spin" />
              {copy.saving}
            </span>
          ) : saveStatus === "saved" ? (
            <span className="flex items-center gap-1.5 text-(--success)">
              <Check className="h-3 w-3" />
              {copy.saved}
            </span>
          ) : null}
        </div>
      </div>

      {layers.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 z-(--z-overlay) flex items-center justify-center p-6">
          <div className="pointer-events-auto w-full max-w-md rounded-(--radius-panel) border border-(--border-subtle) bg-(--bg-surface)/95 p-6 text-center shadow-lg backdrop-blur">
            <div
              className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-(--accent-primary)/25 bg-(--accent-primary)/10 text-(--accent-primary)"
              aria-hidden="true"
            >
              <Sparkles className="h-5 w-5" />
            </div>
            <h2 className="text-base font-semibold text-(--text-primary)">
              {copy.noLayersTitle}
            </h2>
            <p className="mt-2 text-sm leading-6 text-(--text-secondary)">
              {copy.noLayersDescription}
            </p>
            {/* Route setup to Settings when the assistant cannot generate yet. */}
            {hasImageBackend ? (
              <div className="mt-5 flex flex-col items-stretch justify-center gap-2 sm:flex-row sm:items-center">
                <Button type="button" variant="accent" onClick={() => setChatOpen(true)}>
                  <Sparkles className="h-4 w-4" />
                  {copy.noLayersPrimaryCta}
                </Button>
                <Button type="button" variant="outline" loading={exitPending} onClick={handleExitToLibrary}>
                  {copy.library}
                </Button>
              </div>
            ) : (
              <div className="mt-5 flex flex-col gap-3">
                <div className="rounded-lg bg-(--warning-soft) p-4 text-left">
                  <p className="text-sm font-semibold text-(--warning)">
                    {canvasCapabilityIssue.title}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-(--text-secondary)">
                    {canvasCapabilityIssue.reason ?? canvasCapabilityIssue.detail}
                  </p>
                  {canvasCapabilityIssue.href && canvasCapabilityIssue.actionLabel ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-3 border-(--warning-soft) text-(--warning) hover:bg-(--warning-soft)"
                      onClick={() => router.push(canvasCapabilityIssue.href!)}
                    >
                      {canvasCapabilityIssue.actionLabel}
                    </Button>
                  ) : null}
                </div>
                <Button type="button" variant="outline" loading={exitPending} onClick={handleExitToLibrary}>
                  {returnLabel}
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* Mobile: edit controls and the chat dock share one natural-flow bottom
          lane, so neither has to guess the other's height. Desktop: the lane
          dissolves (`sm:contents`) and each child takes its own anchored slot. */}
      <div
        data-slot="canvas-mobile-bottom-lane"
        className="pointer-events-none absolute inset-x-2 bottom-16 z-(--z-modal) flex flex-col items-stretch gap-2 sm:contents"
      >
        {/* Contextual editing docks to the right on desktop and above the toolbar on mobile. */}
        {selectedLayerId ? (
          <div
            className={cn(
              "pointer-events-auto border border-(--border-subtle) bg-(--bg-surface)/95 shadow-lg backdrop-blur",
              "rounded-(--radius-panel) p-3",
              // Desktop: right-edge rail, vertically centered.
              "sm:absolute sm:z-(--z-overlay) sm:right-4 sm:top-1/2 sm:w-56 sm:-translate-y-1/2",
              chatOpen ? "hidden sm:block" : "",
            )}
          >
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-(--text-secondary)">
              <Wand2 className="h-3.5 w-3.5" />
              {copy.editActionsTitle}
            </div>
            {hasFalImageEditing ? (
              <div className="flex flex-row gap-2 sm:flex-col">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={loading || Boolean(error) || chat.isRunning}
                  onClick={() => void handleInpaintHere()}
                  className="flex-1 sm:w-full"
                >
                  {copy.inpaintHere}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={loading || Boolean(error) || chat.isRunning}
                  onClick={handleRemoveBackground}
                  className="flex-1 sm:w-full"
                >
                  {copy.removeBg}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs leading-relaxed text-(--text-muted)">
                  {copy.noImageEditBackendTitle}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => router.push("/settings?panel=provider-connections")}
                >
                  {copy.setUpImageEditing}
                </Button>
              </div>
            )}
          </div>
        ) : null}

        {/* Agent chat dock — collapsed = small pill, expanded = 360x480 panel.
            Sits at --z-modal so it clears the canvas bottom toolbar and the
            --z-overlay canvas chrome, offset from the bottom-right to dodge the
            style toolbar. */}
        <div
          className={cn(
            "pointer-events-auto flex flex-col overflow-hidden rounded-(--radius-panel) border border-(--border-subtle) bg-(--bg-base) shadow-xl transition-[width,height,border-color,box-shadow] duration-(--motion-overlay)",
            "sm:absolute sm:z-(--z-modal) sm:bottom-20 sm:right-4",
            chatOpen
              ? "h-[min(480px,calc(100dvh-7rem))] sm:h-[480px] sm:w-[360px]"
              : "h-10 w-32 self-end",
          )}
        >
          {chatOpen ? (
            <>
              <div className="flex flex-none items-center justify-between border-b border-(--border-subtle) bg-(--bg-surface) px-3 py-1.5">
                <span className="text-xs font-semibold text-(--text-primary)">
                  {copy.agent}
                </span>
                <Button
                  type="button"
                  onClick={() => setChatOpen(false)}
                  variant="ghostMuted"
                  size="icon-xs"
                  className="text-xs"
                  aria-label={copy.collapseAgentPanel}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                <AgentChatPanel
                  chat={chat}
                  onFocusAsset={handleFocusAsset}
                  isAssetAvailable={isAssetAvailable}
                  showGenerationOptions
                  className="h-full bg-transparent"
                />
              </div>
            </>
          ) : (
            <Button
              type="button"
              onClick={() => setChatOpen(true)}
              variant="ghost"
              className="h-full w-full gap-2 text-xs font-semibold text-(--text-primary) hover:bg-(--bg-surface)"
              aria-label={copy.openAgentPanel}
            >
              <span className="inline-block h-2 w-2 rounded-full bg-(--accent-primary)" />
              {copy.agent}
            </Button>
          )}
        </div>
      </div>

      {/* In-canvas prompt for the inpaint description. */}
      <Dialog
        open={promptState.open}
        onOpenChange={(open) => {
          // Closing via Escape / overlay / X resolves the pending askText with
          // null (treated as cancel).
          if (!open) closePrompt(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{promptState.title}</DialogTitle>
          </DialogHeader>
          <Textarea
            ref={(el) => {
              promptInputRef.current = el;
            }}
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                confirmPrompt();
              }
            }}
            placeholder={promptState.placeholder}
            rows={3}
            className="resize-none"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => closePrompt(null)}>
              {copy.cancel}
            </Button>
            <Button
              type="button"
              variant="accent"
              onClick={confirmPrompt}
              disabled={promptState.required && !promptValue.trim()}
            >
              {copy.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
