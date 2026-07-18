"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Image as KonvaImage, Layer, Line, Rect, Stage, Transformer } from "react-konva";
import type Konva from "konva";
import { Button } from "@/components/ui/button";
import { MousePointer2, PenTool, Square, Trash2 } from "@/components/ui/icons";
import { useT } from "@/lib/i18n/useT";
import {
  EMPTY_DRAWING_STATE,
  type CanvasDrawingState,
  type FreehandLine,
} from "@/lib/canvas/drawing-state";

export interface KonvaLayerItem {
  id: string;
  assetId: string;
  assetUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  zIndex: number;
  hidden?: boolean;
  locked?: boolean;
  pixelWidth?: number;
  pixelHeight?: number;
}

export type MaskExportResult =
  | { ok: true; blob: Blob }
  | { ok: false; reason: "no-markers" | "rotated-layer" | "unavailable" };

export interface KonvaStageHandle {
  flushDrawingState: () => void;
  getMaskForLayer: (layerId: string) => Promise<MaskExportResult>;
}

interface KonvaStageProps {
  sessionId: string;
  layers: KonvaLayerItem[];
  drawingState?: CanvasDrawingState;
  selectedLayerId: string | null;
  onSelectLayer?: (layerId: string | null) => void;
  onPatchLayer?: (
    layerId: string,
    patch: Partial<Pick<KonvaLayerItem, "x" | "y" | "width" | "height" | "rotation">>,
  ) => Promise<void> | void;
  onDeleteLayer?: (layerId: string) => void;
  onDrawingStateChange?: (state: CanvasDrawingState) => Promise<void> | void;
  onDrawingStateDirty?: () => void;
  stageRef?: RefObject<KonvaStageHandle | null>;
}

function useAssetImage(src: string): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const next = new window.Image();
    next.crossOrigin = "anonymous";
    next.decoding = "async";
    next.onload = () => setImage(next);
    next.onerror = () => setImage(null);
    next.src = src;
    return () => {
      next.onload = null;
      next.onerror = null;
    };
  }, [src]);
  return image;
}

function AssetNode({
  item,
  selected,
  interactive,
  register,
  onSelect,
  onPatch,
  selectionColor,
  shadowColor,
}: {
  item: KonvaLayerItem;
  selected: boolean;
  interactive: boolean;
  register: (id: string, node: Konva.Image | null) => void;
  onSelect: () => void;
  onPatch: (patch: Partial<KonvaLayerItem>) => void;
  selectionColor: string;
  shadowColor: string;
}) {
  const image = useAssetImage(item.assetUrl);
  return (
    <KonvaImage
      ref={(node) => register(item.id, node)}
      id={`asset-${item.id}`}
      image={image ?? undefined}
      x={item.x}
      y={item.y}
      width={item.width}
      height={item.height}
      rotation={item.rotation ?? 0}
      draggable={interactive && !item.locked}
      listening={interactive}
      opacity={image ? 1 : 0.35}
      stroke={selected ? selectionColor : undefined}
      strokeWidth={selected ? 2 : 0}
      shadowColor={selected ? selectionColor : shadowColor}
      shadowBlur={selected ? 18 : 6}
      shadowOpacity={selected ? 0.28 : 0.16}
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(event) => onPatch({ x: event.target.x(), y: event.target.y() })}
      onTransformEnd={(event) => {
        const node = event.target;
        const width = Math.max(24, node.width() * node.scaleX());
        const height = Math.max(24, node.height() * node.scaleY());
        node.scaleX(1);
        node.scaleY(1);
        onPatch({ x: node.x(), y: node.y(), width, height, rotation: node.rotation() });
      }}
    />
  );
}

function toWorldPoint(stage: Konva.Stage) {
  const pointer = stage.getPointerPosition();
  if (!pointer) return null;
  const transform = stage.getAbsoluteTransform().copy().invert();
  return transform.point(pointer);
}

export function KonvaStage({
  layers,
  drawingState,
  selectedLayerId,
  onSelectLayer,
  onPatchLayer,
  onDeleteLayer,
  onDrawingStateChange,
  onDrawingStateDirty,
  stageRef,
}: KonvaStageProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageNodeRef = useRef<Konva.Stage | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const assetNodesRef = useRef(new Map<string, Konva.Image>());
  const drawingRef = useRef(drawingState ?? EMPTY_DRAWING_STATE);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [tool, setTool] = useState<"select" | "mask">("select");
  const [drawing, setDrawing] = useState(drawingState ?? EMPTY_DRAWING_STATE);
  const activeLineIdRef = useRef<string | null>(null);
  const palette = useMemo(() => {
    const read = (token: string, fallback: string) => {
      if (typeof window === "undefined") return fallback;
      return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || fallback;
    };
    return {
      background: read("--bg-base", "black"),
      anchor: read("--bg-elevated", "black"),
      selection: read("--accent-primary", "white"),
      mask: read("--destructive", "red"),
      shadow: read("--scrim-strong", "black"),
    };
  }, []);

  useEffect(() => {
    const next = drawingState ?? EMPTY_DRAWING_STATE;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      drawingRef.current = next;
      setDrawing(next);
    });
    return () => {
      active = false;
    };
  }, [drawingState]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const visibleLayers = useMemo(
    () => layers.filter((layer) => !layer.hidden).sort((a, b) => a.zIndex - b.zIndex),
    [layers],
  );

  const fitAll = useCallback(() => {
    if (visibleLayers.length === 0) {
      setViewport({ x: 0, y: 0, scale: 1 });
      return;
    }
    const minX = Math.min(...visibleLayers.map((layer) => layer.x));
    const minY = Math.min(...visibleLayers.map((layer) => layer.y));
    const maxX = Math.max(...visibleLayers.map((layer) => layer.x + layer.width));
    const maxY = Math.max(...visibleLayers.map((layer) => layer.y + layer.height));
    const contentWidth = Math.max(1, maxX - minX);
    const contentHeight = Math.max(1, maxY - minY);
    const scale = Math.min(1.5, Math.max(0.1, Math.min((size.width - 160) / contentWidth, (size.height - 160) / contentHeight)));
    setViewport({
      scale,
      x: size.width / 2 - (minX + contentWidth / 2) * scale,
      y: size.height / 2 - (minY + contentHeight / 2) * scale,
    });
  }, [size.height, size.width, visibleLayers]);

  const fittedSessionRef = useRef("");
  useEffect(() => {
    if (visibleLayers.length === 0 || size.width <= 1 || fittedSessionRef.current) return;
    fittedSessionRef.current = visibleLayers.map((layer) => layer.id).join(":");
    fitAll();
  }, [fitAll, size.width, visibleLayers]);

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node = selectedLayerId ? assetNodesRef.current.get(selectedLayerId) : undefined;
    transformer.nodes(node && tool === "select" ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedLayerId, tool, visibleLayers]);

  const persistDrawing = useCallback((next: CanvasDrawingState) => {
    drawingRef.current = next;
    setDrawing(next);
    onDrawingStateDirty?.();
    void onDrawingStateChange?.(next);
  }, [onDrawingStateChange, onDrawingStateDirty]);

  useImperativeHandle(stageRef, () => ({
    flushDrawingState: () => {
      void onDrawingStateChange?.(drawingRef.current);
    },
    getMaskForLayer: async (layerId) => {
      const target = layers.find((layer) => layer.id === layerId);
      if (!target) return { ok: false, reason: "unavailable" };
      if (Math.abs(target.rotation ?? 0) > 0.001) return { ok: false, reason: "rotated-layer" };
      if (drawingRef.current.freehandLines.length === 0) return { ok: false, reason: "no-markers" };
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(target.pixelWidth ?? target.width));
      canvas.height = Math.max(1, Math.round(target.pixelHeight ?? target.height));
      const context = canvas.getContext("2d");
      if (!context) return { ok: false, reason: "unavailable" };
      context.fillStyle = "black";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = "white";
      context.lineCap = "round";
      context.lineJoin = "round";
      for (const line of drawingRef.current.freehandLines) {
        if (line.points.length < 4) continue;
        context.beginPath();
        for (let index = 0; index < line.points.length; index += 2) {
          const x = ((line.points[index]! - target.x) / target.width) * canvas.width;
          const y = ((line.points[index + 1]! - target.y) / target.height) * canvas.height;
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.lineWidth = Math.max(1, (line.strokeWidth / target.width) * canvas.width);
        context.stroke();
      }
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      return blob ? { ok: true, blob } : { ok: false, reason: "unavailable" };
    },
  }), [layers, onDrawingStateChange]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key === "Backspace" || event.key === "Delete") && selectedLayerId && tool === "select") {
        const target = event.target as HTMLElement | null;
        if (target?.matches("input, textarea, [contenteditable=true]")) return;
        event.preventDefault();
        onDeleteLayer?.(selectedLayerId);
      }
      if (event.key === "Escape") {
        setTool("select");
        onSelectLayer?.(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDeleteLayer, onSelectLayer, selectedLayerId, tool]);

  const beginMask = (stage: Konva.Stage) => {
    const point = toWorldPoint(stage);
    if (!point) return;
    const id = crypto.randomUUID();
    activeLineIdRef.current = id;
    const line: FreehandLine = {
      id,
      points: [point.x, point.y],
      stroke: palette.mask,
      strokeWidth: 22 / viewport.scale,
      lineCap: "round",
      lineJoin: "round",
    };
    const next = { ...drawingRef.current, freehandLines: [...drawingRef.current.freehandLines, line] };
    drawingRef.current = next;
    setDrawing(next);
    onDrawingStateDirty?.();
  };

  const extendMask = (stage: Konva.Stage) => {
    const activeId = activeLineIdRef.current;
    const point = toWorldPoint(stage);
    if (!activeId || !point) return;
    const next = {
      ...drawingRef.current,
      freehandLines: drawingRef.current.freehandLines.map((line) =>
        line.id === activeId ? { ...line, points: [...line.points, point.x, point.y] } : line,
      ),
    };
    drawingRef.current = next;
    setDrawing(next);
  };

  const finishMask = () => {
    if (!activeLineIdRef.current) return;
    activeLineIdRef.current = null;
    persistDrawing(drawingRef.current);
  };

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-(--bg-base)">
      <Stage
        ref={stageNodeRef}
        width={size.width}
        height={size.height}
        x={viewport.x}
        y={viewport.y}
        scaleX={viewport.scale}
        scaleY={viewport.scale}
        draggable={tool === "select" && !selectedLayerId}
        onDragEnd={(event) => {
          if (event.target === event.target.getStage()) {
            setViewport((current) => ({ ...current, x: event.target.x(), y: event.target.y() }));
          }
        }}
        onWheel={(event) => {
          event.evt.preventDefault();
          const stage = event.target.getStage();
          const pointer = stage?.getPointerPosition();
          if (!stage || !pointer) return;
          const oldScale = viewport.scale;
          const direction = event.evt.deltaY > 0 ? -1 : 1;
          const nextScale = Math.max(0.1, Math.min(4, oldScale * (direction > 0 ? 1.08 : 1 / 1.08)));
          const world = { x: (pointer.x - viewport.x) / oldScale, y: (pointer.y - viewport.y) / oldScale };
          setViewport({ scale: nextScale, x: pointer.x - world.x * nextScale, y: pointer.y - world.y * nextScale });
        }}
        onMouseDown={(event) => {
          const stage = event.target.getStage();
          if (!stage) return;
          if (tool === "mask") beginMask(stage);
          else if (event.target === stage) onSelectLayer?.(null);
        }}
        onMouseMove={(event) => {
          if (tool === "mask") {
            const stage = event.target.getStage();
            if (stage) extendMask(stage);
          }
        }}
        onMouseUp={finishMask}
        onTouchStart={(event) => {
          const stage = event.target.getStage();
          if (stage && tool === "mask") beginMask(stage);
        }}
        onTouchMove={(event) => {
          const stage = event.target.getStage();
          if (stage && tool === "mask") extendMask(stage);
        }}
        onTouchEnd={finishMask}
      >
        <Layer>
          <Rect x={-100000} y={-100000} width={200000} height={200000} fill={palette.background} listening={false} />
          {visibleLayers.map((item) => (
            <AssetNode
              key={item.id}
              item={item}
              selected={selectedLayerId === item.id}
              interactive={tool === "select"}
              register={(id, node) => {
                if (node) assetNodesRef.current.set(id, node);
                else assetNodesRef.current.delete(id);
              }}
              onSelect={() => onSelectLayer?.(item.id)}
              onPatch={(patch) => void onPatchLayer?.(item.id, patch)}
              selectionColor={palette.selection}
              shadowColor={palette.shadow}
            />
          ))}
          {drawing.freehandLines.map((line) => (
            <Line
              key={line.id}
              points={line.points}
              stroke={line.stroke}
              strokeWidth={line.strokeWidth}
              lineCap={line.lineCap}
              lineJoin={line.lineJoin}
              opacity={0.72}
              listening={false}
            />
          ))}
          <Transformer
            ref={transformerRef}
            rotateEnabled
            keepRatio
            enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]}
            borderStroke={palette.selection}
            anchorStroke={palette.selection}
            anchorFill={palette.anchor}
            anchorSize={10}
            boundBoxFunc={(oldBox, newBox) => newBox.width < 24 || newBox.height < 24 ? oldBox : newBox}
          />
        </Layer>
      </Stage>

      <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-(--border-subtle) bg-(--scrim-strong) p-1.5 shadow-xl backdrop-blur">
        <Button type="button" size="icon-sm" variant={tool === "select" ? "selected" : "ghostMuted"} onClick={() => setTool("select")} aria-label={t("canvas.selectAssets")}>
          <MousePointer2 className="h-4 w-4" />
        </Button>
        <Button type="button" size="icon-sm" variant={tool === "mask" ? "selected" : "ghostMuted"} onClick={() => { setTool("mask"); onSelectLayer?.(selectedLayerId); }} aria-label={t("canvas.paintMask")}>
          <PenTool className="h-4 w-4" />
        </Button>
        <span className="mx-1 h-5 w-px bg-(--border-subtle)" />
        <Button type="button" size="icon-sm" variant="ghostMuted" onClick={() => setViewport((current) => ({ ...current, scale: Math.max(0.1, current.scale / 1.15) }))} aria-label={t("canvas.zoomOut")}>
          <span aria-hidden>−</span>
        </Button>
        <span className="min-w-12 text-center text-[11px] text-(--text-muted)">{Math.round(viewport.scale * 100)}%</span>
        <Button type="button" size="icon-sm" variant="ghostMuted" onClick={() => setViewport((current) => ({ ...current, scale: Math.min(4, current.scale * 1.15) }))} aria-label={t("canvas.zoomIn")}>
          <span aria-hidden>+</span>
        </Button>
        <Button type="button" size="icon-sm" variant="ghostMuted" onClick={fitAll} aria-label={t("canvas.fitAll")}>
          <Square className="h-4 w-4" />
        </Button>
        {drawing.freehandLines.length > 0 ? (
          <Button type="button" size="icon-sm" variant="ghostMuted" onClick={() => persistDrawing({ ...drawingRef.current, freehandLines: [] })} aria-label={t("canvas.clearMask")}>
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
