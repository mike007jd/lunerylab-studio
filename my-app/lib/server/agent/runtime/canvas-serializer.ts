/**
 * Canvas serializer — turn a canvas session into a compact, LLM-readable
 * description so the agent can "see" what's on the canvas before acting.
 *
 * v1 fed the LLM only `imageLayerCount: number`. v2 keeps the full layer list
 * in the server snapshot, then sends a bounded projection (id, kind,
 * dimensions, position, hidden, prompt fragment) to the model. Omitted layers
 * remain available through focused or paged observe_canvas calls.
 *
 * Keep output compact: long strings cost tokens. Truncate prompt fragments.
 */

import { prisma } from "@/lib/server/prisma";
import { CANVAS_LAYER_ORDER_BY } from "@/lib/server/canvas-layer-order";
import { parseDrawingState } from "@/lib/canvas/drawing-state";
import {
  getDefaultReferenceSet,
  renderDefaultReferenceSetForPrompt,
  type ReferenceSetSnapshot,
} from "@/lib/server/reference-set";

export interface CanvasLayerSnapshot {
  id: string;
  index: number;
  assetId: string;
  assetKind: "REFERENCE" | "GENERATED";
  /** Generation prompt (truncated) — only present for GENERATED assets. */
  promptFragment?: string;
  /** Layer geometry in canvas coordinate space. */
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  hidden: boolean;
  locked: boolean;
  /** True if this layer is currently selected. */
  selected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasSnapshot {
  sessionId: string;
  projectId: string | null;
  title: string;
  layerCount: number;
  selectedLayerId: string | null;
  layers: CanvasLayerSnapshot[];
  annotationCount: number;
  annotationText: string[];
  defaultReferenceSet: ReferenceSetSnapshot | null;
}

const PROMPT_FRAGMENT_LIMIT = 140;
const CANVAS_TITLE_LIMIT = 160;
export const CANVAS_SNAPSHOT_LAYER_LIMIT = 32;
const TOPMOST_VISIBLE_LAYER_QUOTA = 20;
const RECENT_LAYER_QUOTA = 8;

function truncate(text: string | null | undefined, limit: number): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

export async function buildCanvasSnapshot(
  sessionId: string,
  userId: string,
  selectedLayerId: string | null,
): Promise<CanvasSnapshot | null> {
  const session = await prisma.canvasSession.findUnique({
    where: { id: sessionId, userId },
    include: {
      layers: {
        orderBy: CANVAS_LAYER_ORDER_BY,
        include: {
          asset: {
            select: {
              id: true,
              kind: true,
              jobId: true,
            },
          },
        },
      },
    },
  });

  if (!session) return null;

  // Lazy-load the default reference set so the snapshot always has the slot
  // populated (or null if the project has none / lookup fails).
  const projectId = session.projectId;
  const defaultReferenceSet = projectId
    ? await getDefaultReferenceSet(projectId, userId).catch(() => null)
    : null;

  // Pull prompt fragments for any GENERATED layers, batched by jobId.
  const generatedJobIds = Array.from(
    new Set(
      session.layers
        .filter((l) => l.asset.kind === "GENERATED" && l.asset.jobId)
        .map((l) => l.asset.jobId as string),
    ),
  );
  const jobPrompts = generatedJobIds.length
    ? await prisma.generationJob.findMany({
        where: { id: { in: generatedJobIds } },
        select: { id: true, prompt: true },
      })
    : [];
  const promptByJob = new Map(jobPrompts.map((j) => [j.id, j.prompt ?? ""]));
  const drawingState = parseDrawingState(session.drawingState);
  const annotationText = drawingState.textNodes.map((node) => node.text)
    .filter(Boolean)
    .slice(0, 8);
  const annotationCount =
    drawingState.freehandLines.length +
    drawingState.textNodes.length +
    drawingState.shapes.length;

  return {
    sessionId: session.id,
    projectId,
    title: session.title,
    layerCount: session.layers.length,
    selectedLayerId,
    annotationCount,
    annotationText,
    defaultReferenceSet,
    layers: session.layers.map<CanvasLayerSnapshot>((layer, idx) => ({
      id: layer.id,
      index: idx,
      assetId: layer.assetId,
      assetKind: layer.asset.kind as "REFERENCE" | "GENERATED",
      promptFragment:
        layer.asset.kind === "GENERATED" && layer.asset.jobId
          ? truncate(promptByJob.get(layer.asset.jobId), PROMPT_FRAGMENT_LIMIT)
          : undefined,
      x: layer.x,
      y: layer.y,
      width: layer.width,
      height: layer.height,
      zIndex: layer.zIndex,
      hidden: layer.hidden,
      locked: layer.locked,
      selected: layer.id === selectedLayerId,
      createdAt: layer.createdAt.toISOString(),
      updatedAt: layer.updatedAt.toISOString(),
    })),
  };
}

export interface CanvasSnapshotRenderOptions {
  /** Exact layer to force into the prioritized summary. */
  focusLayerId?: string | null;
  /** Original back-to-front array offset for deterministic paging. */
  startIndex?: number;
  /** Bounded page/summary size. Values above the hard limit are clamped. */
  layerLimit?: number;
}

export interface CanvasSnapshotProjection {
  text: string;
  includedLayerCount: number;
  omittedLayerCount: number;
  nextStartIndex: number | null;
  focusedLayerFound: boolean | null;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareFrontFirst(a: CanvasLayerSnapshot, b: CanvasLayerSnapshot): number {
  if (a.zIndex !== b.zIndex) return b.zIndex - a.zIndex;
  if (a.index !== b.index) return b.index - a.index;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

function compareRecentFirst(a: CanvasLayerSnapshot, b: CanvasLayerSnapshot): number {
  const updatedDiff = timestamp(b.updatedAt) - timestamp(a.updatedAt);
  if (updatedDiff !== 0) return updatedDiff;
  const createdDiff = timestamp(b.createdAt) - timestamp(a.createdAt);
  return createdDiff || compareFrontFirst(a, b);
}

function selectPrioritizedLayers(
  snapshot: CanvasSnapshot,
  focusLayerId: string | null,
  limit: number,
): CanvasLayerSnapshot[] {
  const selected: CanvasLayerSnapshot[] = [];
  const seen = new Set<string>();
  const add = (layer: CanvasLayerSnapshot | undefined) => {
    if (!layer || selected.length >= limit || seen.has(layer.id)) return false;
    seen.add(layer.id);
    selected.push(layer);
    return true;
  };

  if (focusLayerId) add(snapshot.layers.find((layer) => layer.id === focusLayerId));
  if (snapshot.selectedLayerId) {
    add(snapshot.layers.find((layer) => layer.id === snapshot.selectedLayerId));
  } else {
    add(snapshot.layers.find((layer) => layer.selected));
  }

  const frontFirst = [...snapshot.layers].sort(compareFrontFirst);
  for (const layer of frontFirst.filter((candidate) => !candidate.hidden).slice(0, TOPMOST_VISIBLE_LAYER_QUOTA)) {
    add(layer);
  }

  let recentAdded = 0;
  for (const layer of [...snapshot.layers].sort(compareRecentFirst)) {
    if (add(layer)) recentAdded += 1;
    if (recentAdded >= RECENT_LAYER_QUOTA || selected.length >= limit) break;
  }

  for (const layer of frontFirst) add(layer);
  return selected;
}

function normalizeLayerLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CANVAS_SNAPSHOT_LAYER_LIMIT;
  }
  return Math.max(1, Math.min(CANVAS_SNAPSHOT_LAYER_LIMIT, Math.floor(value)));
}

/**
 * Build a bounded projection plus navigation metadata. Default mode is a
 * prioritized summary; startIndex switches to a deterministic back-to-front
 * page so every omitted layer remains discoverable.
 */
export function projectCanvasSnapshot(
  snapshot: CanvasSnapshot,
  options: CanvasSnapshotRenderOptions = {},
): CanvasSnapshotProjection {
  const layerLimit = normalizeLayerLimit(options.layerLimit);
  const focusLayerId = options.focusLayerId?.trim() || null;
  const hasPage = options.startIndex !== undefined;
  const requestedStartIndex = options.startIndex ?? 0;
  const startIndex = hasPage
    ? Math.max(0, Math.min(snapshot.layers.length, Math.floor(requestedStartIndex)))
    : 0;
  const projectedLayers = hasPage
    ? snapshot.layers.slice(startIndex, startIndex + layerLimit)
    : snapshot.layers.length <= layerLimit
      ? snapshot.layers
      : selectPrioritizedLayers(snapshot, focusLayerId, layerLimit);
  const omittedLayerCount = Math.max(0, snapshot.layers.length - projectedLayers.length);
  const nextStartIndex = hasPage
    ? startIndex + projectedLayers.length < snapshot.layers.length
      ? startIndex + projectedLayers.length
      : null
    : omittedLayerCount > 0
      ? 0
      : null;
  const focusedLayerFound = focusLayerId
    ? snapshot.layers.some((layer) => layer.id === focusLayerId)
    : null;

  const lines: string[] = [];
  const refLine = renderDefaultReferenceSetForPrompt(snapshot.defaultReferenceSet);
  if (refLine) lines.push(refLine);
  if (lines.length > 0) lines.push("");
  lines.push(
    `Canvas "${truncate(snapshot.title, CANVAS_TITLE_LIMIT) ?? "Untitled"}" — ${snapshot.layerCount} layer(s)`,
  );
  if (snapshot.selectedLayerId) {
    const selectedFound = snapshot.layers.some((layer) => layer.id === snapshot.selectedLayerId);
    lines.push(
      selectedFound
        ? `Selected layer id: ${snapshot.selectedLayerId}`
        : `Selected layer id: ${snapshot.selectedLayerId} (not found in current canvas)`,
    );
  } else {
    lines.push("No layer selected.");
  }
  if (focusLayerId) {
    lines.push(
      focusedLayerFound
        ? `Focused layer id: ${focusLayerId}`
        : `Focused layer id: ${focusLayerId} (not found in current canvas)`,
    );
  }
  if (snapshot.layers.length === 0) {
    lines.push("(empty canvas)");
  } else {
    lines.push(
      hasPage
        ? `Layers page from startIndex=${startIndex} (original indices, back to front):`
        : omittedLayerCount > 0
          ? "Layers (prioritized summary; original index is back-to-front):"
          : "Layers (from back to front):",
    );
    for (const layer of projectedLayers) {
      const marks: string[] = [];
      if (layer.selected) marks.push("SELECTED");
      if (layer.hidden) marks.push("hidden");
      if (layer.locked) marks.push("locked");
      const flags = marks.length ? ` [${marks.join(", ")}]` : "";
      const kindLabel = layer.assetKind === "REFERENCE" ? "ref" : "gen";
      const promptFragment = truncate(layer.promptFragment, PROMPT_FRAGMENT_LIMIT);
      const promptBit = promptFragment ? ` — "${promptFragment}"` : "";
      lines.push(
        `  ${layer.index}. id=${layer.id} ${kindLabel} ${Math.round(layer.width)}×${Math.round(layer.height)} @ z=${layer.zIndex}${flags}${promptBit}`,
      );
    }
    if (omittedLayerCount > 0) {
      lines.push(`Omitted ${omittedLayerCount} of ${snapshot.layers.length} layers from this view.`);
      if (hasPage) {
        lines.push(
          nextStartIndex === null
            ? "This is the final layer page."
            : `Inspect the next layer page with observe_canvas (next startIndex=${nextStartIndex}).`,
        );
      } else {
        lines.push(
          "Use observe_canvas with layerId for an exact layer, or startIndex/limit to page through every omitted layer.",
        );
      }
    }
  }
  if (snapshot.annotationCount > 0) {
    lines.push(`Annotations: ${snapshot.annotationCount}`);
    for (const text of snapshot.annotationText.slice(0, 8)) {
      lines.push(`  note="${truncate(text, 80) ?? ""}"`);
    }
  }
  return {
    text: lines.join("\n"),
    includedLayerCount: projectedLayers.length,
    omittedLayerCount,
    nextStartIndex,
    focusedLayerFound,
  };
}

/**
 * Render a canvas snapshot as a compact text block suitable for embedding in
 * the agent's user prompt. The LLM uses this as its primary "what's on the
 * canvas right now" context.
 */
export function renderCanvasSnapshot(
  snapshot: CanvasSnapshot,
  options: CanvasSnapshotRenderOptions = {},
): string {
  return projectCanvasSnapshot(snapshot, options).text;
}
