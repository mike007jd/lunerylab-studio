"use client";

/**
 * Canvas workspace: persisted Konva asset stage, editing tools, and Luna.
 *
 * This surface composes owners; it does not own canvas state. The write ledger
 * holds dirty/pending facts, `useCanvasAuthoritativeSync` owns server truth and
 * reconciliation, `useCanvasPersistenceCoordinator` owns every outbound write
 * plus the flush/exit contract, and `useCanvasLayerLockBinding` wires the lock
 * controller to both. Page-level state here is limited to what the chrome
 * itself owns: layer selection and the agent dock.
 */

import { useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { KonvaStageHandle } from "@/components/canvas/konva-stage";
import { hasFalImageEditBackend } from "@/components/canvas/image-edit-capability";
import { CanvasRouteState } from "@/components/canvas/canvas-route-state";
import {
  createCanvasLayerLockController,
  type CanvasLayerLockController,
} from "@/components/canvas/canvas-layer-lock";
import { CanvasStageLoading } from "@/components/canvas/canvas-stage-loading";
import { CanvasExportPopover } from "@/components/canvas/canvas-export-popover";
import {
  CanvasTextPromptDialog,
  useCanvasTextPrompt,
} from "@/components/canvas/canvas-text-prompt";
import { COPY } from "@/components/canvas/canvas-copy";
import {
  createCanvasWriteLedger,
  type CanvasWriteLedger,
} from "@/components/canvas/canvas-write-ledger";
import { useCanvasAuthoritativeSync } from "@/components/canvas/use-canvas-authoritative-sync";
import { useCanvasExport } from "@/components/canvas/use-canvas-export";
import { useCanvasLayerLockBinding } from "@/components/canvas/use-canvas-layer-lock-binding";
import { useCanvasPersistenceCoordinator } from "@/components/canvas/use-canvas-persistence-coordinator";
import { AgentChatPanel } from "@/components/studio/agent-chat-panel";
import { useAgentChat } from "@/components/studio/agent-chat/use-agent-chat";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Check, Loader2, Sparkles, Wand2, X } from "@/components/ui/icons";
import {
  resolveSelectableImageModelId,
  useModelCatalog,
} from "@/lib/client/use-model-catalog";
import { useSharedBootstrapSnapshot } from "@/lib/client/bootstrap-snapshot-provider";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import { useCreativeCapabilityReadiness } from "@/hooks/use-creative-capability-readiness";
import { resolveCanvasReturnTarget } from "@/lib/client/creation-flow";

// Konva is browser-only; load it on the client. We pass the imperative
// handle as a `stageRef` prop because next/dynamic strips React refs.
const KonvaStage = dynamic(
  () => import("@/components/canvas/konva-stage").then((m) => m.KonvaStage),
  {
    ssr: false,
    loading: CanvasStageLoading,
  },
);

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

  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const stageRef = useRef<KonvaStageHandle | null>(null);

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

  // Shared, component-scoped owners. The ledger is the one place local dirty
  // state lives; the lock controller outlives any single session binding.
  const [writeLedger] = useState<CanvasWriteLedger>(createCanvasWriteLedger);
  const [layerLockController] = useState<CanvasLayerLockController>(
    createCanvasLayerLockController,
  );

  // Selection is page chrome, so removals have to be released here.
  const handleLayersRemoved = useCallback((removedIds: readonly string[]) => {
    setSelectedLayerId((current) =>
      current && removedIds.includes(current) ? null : current,
    );
  }, []);

  const sync = useCanvasAuthoritativeSync({
    sessionId,
    ledger: writeLedger,
    lockController: layerLockController,
    copy,
    // Only the agent mutates the canvas from outside this window.
    pollWhenActive: chatOpen || chat.isRunning,
    pollIntervalMs: chat.isRunning ? 3000 : 8000,
    onLayersRemoved: handleLayersRemoved,
  });
  const { layers, drawingState, loading, error } = sync;

  const persistence = useCanvasPersistenceCoordinator({
    sessionId,
    ledger: writeLedger,
    lockController: layerLockController,
    stageRef,
    copy,
    isLayerLocked: sync.isLayerLocked,
    applyLocalDrawingState: sync.applyLocalDrawingState,
    requestAuthoritativeResync: sync.resyncLayers,
  });

  const layerLock = useCanvasLayerLockBinding({
    sessionId,
    lockController: layerLockController,
    copy,
    flushPendingGeometry: persistence.flushPendingGeometry,
    getLocalLocked: sync.isLayerLocked,
    setLocalLocked: sync.setLayerLockedLocally,
    requestAuthoritativeResync: sync.resyncLayers,
  });

  const canvasExport = useCanvasExport({ sessionId, stageRef, copy });
  const { askText, prompt: textPrompt } = useCanvasTextPrompt();

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
        toast.error(copy.toastAssetNotOnCanvas);
        return;
      }
      setSelectedLayerId(layer.id);
    },
    [layers, copy],
  );

  // In-app exits wait for drawing/geometry queues and pending lock transitions
  // before navigating; a failed drain keeps the user on the canvas.
  const handleExitToLibrary = useCallback(async () => {
    const drained = await persistence.flushForExit();
    if (!drained) return;
    router.push(returnTarget.href);
  }, [persistence, returnTarget.href, router]);

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
        <Button type="button" variant="accent" onClick={sync.retry}>
          {copy.retry}
        </Button>
        <Button
          type="button"
          variant="outline"
          loading={persistence.exitPending}
          onClick={handleExitToLibrary}
        >
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
        onPatchLayer={persistence.patchLayerGeometry}
        onDeleteLayer={sync.deleteLayer}
        onToggleLock={layerLock.toggleLayerLock}
        isLockPending={layerLock.isLayerLockPending}
        onDrawingStateDirty={persistence.handleDrawingStateDirty}
        onDrawingStateChange={persistence.handleDrawingStateChange}
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
          loading={persistence.exitPending}
          onClick={handleExitToLibrary}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {returnLabel}
        </Button>
        <div className="pointer-events-auto">
          <CanvasExportPopover
            disabled={!layers.some((layer) => !layer.hidden)}
            busy={canvasExport.exportBusy}
            isChinese={locale.startsWith("zh")}
            copy={copy}
            onExportOriginal={canvasExport.exportOriginal}
            onExportPlatforms={canvasExport.exportPlatforms}
          />
        </div>
        {/* Fixed width prevents save-status changes from shifting the toolbar. */}
        <div
          className="pointer-events-none flex h-7 items-center gap-1.5 rounded-md px-2 text-xs"
          style={{ minWidth: "5.5rem" }}
          aria-live="polite"
        >
          {persistence.saveStatus === "saving" ? (
            <span className="flex items-center gap-1.5 text-(--text-muted)">
              <Loader2 className="h-3 w-3 animate-spin" />
              {copy.saving}
            </span>
          ) : persistence.saveStatus === "saved" ? (
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
                <Button
                  type="button"
                  variant="outline"
                  loading={persistence.exitPending}
                  onClick={handleExitToLibrary}
                >
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
                <Button
                  type="button"
                  variant="outline"
                  loading={persistence.exitPending}
                  onClick={handleExitToLibrary}
                >
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

      <CanvasTextPromptDialog prompt={textPrompt} copy={copy} />
    </div>
  );
}
