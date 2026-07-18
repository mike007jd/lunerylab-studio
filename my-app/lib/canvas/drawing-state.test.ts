import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAWING_STATE,
  parseDrawingState,
  serializeDrawingState,
  type CanvasDrawingState,
} from "./drawing-state";

describe("canvas drawing state", () => {
  it("normalizes missing and invalid collections", () => {
    expect(parseDrawingState(null)).toEqual(EMPTY_DRAWING_STATE);
    expect(parseDrawingState({ version: 1 })).toEqual(EMPTY_DRAWING_STATE);
  });

  it("round-trips the Konva annotation contract", () => {
    const state: CanvasDrawingState = {
      version: 1,
      freehandLines: [{
        id: "mask-1",
        points: [1, 2, 3, 4],
        stroke: "#ef4444",
        strokeWidth: 20,
        lineCap: "round",
        lineJoin: "round",
      }],
      textNodes: [],
      shapes: [],
    };
    expect(serializeDrawingState(parseDrawingState(state))).toEqual(state);
  });
});
