"use client";

import { useCallback, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown, Layers as LayersIcon, Lock, LockOpen } from "@/components/ui/icons";
import { useT } from "@/lib/i18n/useT";
import { cn } from "@/lib/utils";
import type { KonvaLayerItem } from "@/components/canvas/konva-stage";

const NUDGE_STEP = 10;
const MIN_LAYER_SIZE = 24;

export interface CanvasLayerControlProps {
  layers: KonvaLayerItem[];
  selectedLayerId: string | null;
  onSelectLayer?: (layerId: string | null) => void;
  onPatchLayer?: (
    layerId: string,
    patch: Partial<Pick<KonvaLayerItem, "x" | "y" | "width" | "height">>,
  ) => Promise<void> | void;
  onDeleteLayer?: (layerId: string) => void;
  onToggleLock?: (layerId: string, locked: boolean) => void;
  /** True while a lock/unlock transition is queued or in flight for the layer. */
  isLockPending?: (layerId: string) => boolean;
  /** True while delete/lock ownership forbids geometry and destructive input. */
  isInteractionBlocked?: (layerId: string) => boolean;
}

/**
 * Compact artwork-first DOM layer control for keyboard and VoiceOver users.
 * The Konva stage itself is pointer-only; this labelled list of independently
 * focusable toggle buttons mirrors every layer so assistive tech can discover,
 * select (Enter), move (arrows), resize (Shift+arrows), and delete (Delete)
 * the selected layer. Sibling layers stay reachable at all times: Tab moves
 * between buttons, and arrows only act on the artwork once its layer is
 * selected. Locked layers report their state and reject move/resize/delete.
 * Each row also carries a separate, independently focusable lock/unlock
 * button — a sibling, never nested — whose activation neither selects the
 * layer nor leaks Delete/arrow keys into geometry handling.
 */
export function CanvasLayerControl({
  layers,
  selectedLayerId,
  onSelectLayer,
  onPatchLayer,
  onDeleteLayer,
  onToggleLock,
  isLockPending,
  isInteractionBlocked,
}: CanvasLayerControlProps) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const orderedLayers = [...layers].sort((a, b) => b.zIndex - a.zIndex);
  const selectedLayer = orderedLayers.find((layer) => layer.id === selectedLayerId) ?? null;

  const patchLayer = useCallback(
    (layer: KonvaLayerItem, patch: Partial<Pick<KonvaLayerItem, "x" | "y" | "width" | "height">>) => {
      void onPatchLayer?.(layer.id, patch);
    },
    [onPatchLayer],
  );

  const handleLayerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, layer: KonvaLayerItem) => {
      const selected = layer.id === selectedLayerId;

      if (event.key === "Enter") {
        // preventDefault suppresses the native button click so selection fires
        // exactly once. Space activates the button natively via click.
        event.preventDefault();
        onSelectLayer?.(layer.id);
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        // Keep the stage-level window Delete shortcut from firing a second time.
        event.stopPropagation();
        if (layer.locked || isInteractionBlocked?.(layer.id)) return;
        onSelectLayer?.(layer.id);
        onDeleteLayer?.(layer.id);
        return;
      }

      const isArrow =
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === "ArrowLeft" ||
        event.key === "ArrowRight";
      if (!isArrow) return;

      // Arrows only act on the artwork once its layer is selected; otherwise
      // they keep their default behavior so focus stays predictable. Locked
      // layers never move or resize.
      if (!selected || layer.locked || isInteractionBlocked?.(layer.id)) return;
      event.preventDefault();

      if (event.shiftKey) {
        // Modified arrows resize, clamped to the same floor as the stage.
        const patch: Partial<Pick<KonvaLayerItem, "width" | "height">> = {};
        if (event.key === "ArrowRight") patch.width = Math.max(MIN_LAYER_SIZE, layer.width + NUDGE_STEP);
        if (event.key === "ArrowLeft") patch.width = Math.max(MIN_LAYER_SIZE, layer.width - NUDGE_STEP);
        if (event.key === "ArrowDown") patch.height = Math.max(MIN_LAYER_SIZE, layer.height + NUDGE_STEP);
        if (event.key === "ArrowUp") patch.height = Math.max(MIN_LAYER_SIZE, layer.height - NUDGE_STEP);
        patchLayer(layer, patch);
      } else {
        const patch: Partial<Pick<KonvaLayerItem, "x" | "y">> = {};
        if (event.key === "ArrowRight") patch.x = layer.x + NUDGE_STEP;
        if (event.key === "ArrowLeft") patch.x = layer.x - NUDGE_STEP;
        if (event.key === "ArrowDown") patch.y = layer.y + NUDGE_STEP;
        if (event.key === "ArrowUp") patch.y = layer.y - NUDGE_STEP;
        patchLayer(layer, patch);
      }
    },
    [
      selectedLayerId,
      onSelectLayer,
      onDeleteLayer,
      patchLayer,
      isInteractionBlocked,
    ],
  );

  if (orderedLayers.length === 0) return null;

  return (
    <div
      data-slot="canvas-layer-control"
      className="pointer-events-auto absolute right-4 top-4 z-(--z-overlay) w-48"
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-controls="canvas-layer-list"
        onClick={() => setOpen((current) => !current)}
        className="w-full justify-between gap-2 shadow-md"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <LayersIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{t("canvas.layers")}</span>
          <span className="text-(--text-muted)">{orderedLayers.length}</span>
        </span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-(--motion-control)", open ? "rotate-180" : "")}
          aria-hidden
        />
      </Button>

      {open ? (
        <div className="mt-1.5 rounded-(--radius-panel) border border-(--border-subtle) bg-(--bg-surface)/95 p-1.5 shadow-lg backdrop-blur">
          <ul
            id="canvas-layer-list"
            aria-label={t("canvas.layersPanel.ariaLabel")}
            aria-describedby="canvas-layer-control-hint"
            className="max-h-56 overflow-y-auto"
          >
            {orderedLayers.map((layer, index) => {
              const selected = layer.id === selectedLayerId;
              const lockPending = Boolean(isLockPending?.(layer.id));
              const interactionBlocked = Boolean(isInteractionBlocked?.(layer.id));
              return (
                <li key={layer.id} className="flex items-stretch gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-pressed={selected}
                    onClick={() => onSelectLayer?.(layer.id)}
                    onKeyDown={(event) => handleLayerKeyDown(event, layer)}
                    className={cn(
                      "h-auto min-w-0 flex-1 justify-between gap-2 px-2 py-1.5 text-left text-xs",
                      selected
                        ? "bg-(--accent-primary)/12 text-(--text-primary) hover:bg-(--accent-primary)/12"
                        : "text-(--text-secondary) hover:bg-(--bg-elevated)",
                      layer.hidden ? "opacity-60" : "",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {t("canvas.layersPanel.layerName", { index: index + 1 })}
                    </span>
                    <span className="shrink-0 tabular-nums text-(--text-muted)">
                      {Math.round(layer.width)}×{Math.round(layer.height)}
                    </span>
                    {layer.locked ? (
                      <span className="sr-only">{t("canvas.layersPanel.layerLocked")}</span>
                    ) : null}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-pressed={Boolean(layer.locked)}
                    loading={lockPending}
                    aria-label={t(
                      layer.locked
                        ? "canvas.layersPanel.unlockLayer"
                        : "canvas.layersPanel.lockLayer",
                    )}
                    onClick={() => {
                      if (lockPending || interactionBlocked) return;
                      onToggleLock?.(layer.id, !layer.locked);
                    }}
                    className={cn(
                      "h-auto shrink-0 self-stretch",
                      layer.locked
                        ? "text-(--warning) hover:bg-(--warning-soft)"
                        : "text-(--text-muted) hover:text-(--text-primary)",
                    )}
                  >
                    {layer.locked ? (
                      <Lock className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <LockOpen className="h-3.5 w-3.5" aria-hidden />
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
          <p
            id="canvas-layer-control-hint"
            className="mt-1 border-t border-(--border-subtle) px-2 pt-1.5 text-xs leading-snug text-(--text-muted)"
          >
            {t("canvas.layersPanel.keyboardHint")}
            {selectedLayer?.locked ? (
              <span className="mt-0.5 block">{t("canvas.layersPanel.lockedSelected")}</span>
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}
