/** Canonical persisted annotation state for the focused Konva asset editor. */

export interface FreehandLine {
  id: string;
  points: number[];
  stroke: string;
  strokeWidth: number;
  lineCap: "round" | "butt" | "square";
  lineJoin: "round" | "bevel" | "miter";
}

export interface TextNode {
  id: string;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  fontFamily: string;
  fill: string;
  align: "left" | "center" | "right";
  width?: number;
}

export type ShapeType = "rect" | "circle" | "arrow";

export interface ShapeNode {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: string;
  strokeWidth: number;
  fill: string;
  dash?: number[];
  points?: number[];
}

export interface CanvasDrawingState {
  version: 1;
  freehandLines: FreehandLine[];
  textNodes: TextNode[];
  shapes: ShapeNode[];
}

export const EMPTY_DRAWING_STATE: CanvasDrawingState = {
  version: 1,
  freehandLines: [],
  textNodes: [],
  shapes: [],
};

const MAX_DRAWING_ITEMS = 5000;

function cappedArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value.slice(0, MAX_DRAWING_ITEMS) as T[] : [];
}

export function parseDrawingState(value: unknown): CanvasDrawingState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_DRAWING_STATE;
  const state = value as Partial<CanvasDrawingState>;
  return {
    version: 1,
    freehandLines: cappedArray<FreehandLine>(state.freehandLines),
    textNodes: cappedArray<TextNode>(state.textNodes),
    shapes: cappedArray<ShapeNode>(state.shapes),
  };
}

export function serializeDrawingState(state: CanvasDrawingState): CanvasDrawingState {
  return {
    version: 1,
    freehandLines: state.freehandLines,
    textNodes: state.textNodes,
    shapes: state.shapes,
  };
}
