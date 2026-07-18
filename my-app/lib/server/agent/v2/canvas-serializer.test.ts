import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  renderCanvasSnapshot,
  type CanvasSnapshot,
} from "@/lib/server/agent/v2/canvas-serializer";

function largeSnapshot(layerCount = 80): CanvasSnapshot {
  const layers = Array.from({ length: layerCount }, (_, index) => ({
    id: `layer-${index}`,
    index,
    assetId: `asset-${index}`,
    assetKind: index % 3 === 0 ? "REFERENCE" : "GENERATED",
    promptFragment: "detailed product photography prompt ".repeat(8),
    x: index * 10,
    y: index * 5,
    width: 1024,
    height: 1024,
    zIndex: index,
    hidden: index === 2 || index === 3,
    locked: false,
    selected: index === 2,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    updatedAt: new Date(
      index === 3 ? Date.UTC(2026, 6, 13) : Date.UTC(2026, 0, 1, 0, 0, index),
    ).toISOString(),
  }));
  return {
    sessionId: "session-1",
    projectId: "project-1",
    title: "Very long canvas title ".repeat(1_000),
    layerCount,
    selectedLayerId: "layer-2",
    layers,
    annotationCount: 0,
    annotationText: [],
    defaultReferenceSet: null,
  } as CanvasSnapshot;
}

function renderedLayerIds(output: string): string[] {
  return [...output.matchAll(/^\s+\d+\. id=([^\s]+)/gm)].map((match) => match[1]!);
}

describe("renderCanvasSnapshot", () => {
  it("bounds a large prompt and explicitly prioritizes selected, topmost visible, and recent layers", () => {
    const output = renderCanvasSnapshot(largeSnapshot());
    const ids = renderedLayerIds(output);

    expect(ids).toHaveLength(32);
    expect(ids).toContain("layer-2");
    expect(ids).toContain("layer-79");
    expect(ids).toContain("layer-3");
    expect(ids).not.toContain("layer-0");
    expect(output).toContain("Omitted 48 of 80 layers");
    expect(output.length).toBeLessThanOrEqual(10_000);
    expect(renderCanvasSnapshot(largeSnapshot())).toBe(output);
  });

  it("supports bounded deterministic pages so omitted layers remain discoverable", () => {
    const output = renderCanvasSnapshot(largeSnapshot(), { startIndex: 20, layerLimit: 5 });
    const ids = renderedLayerIds(output);

    expect(ids).toEqual(["layer-20", "layer-21", "layer-22", "layer-23", "layer-24"]);
    expect(output).toContain("Omitted 75 of 80 layers");
    expect(output).toContain("next startIndex=25");
  });

  it("always includes an explicitly requested layer outside the default summary", () => {
    const output = renderCanvasSnapshot(largeSnapshot(), { focusLayerId: "layer-0" });

    expect(renderedLayerIds(output)).toContain("layer-0");
    expect(output).toContain("Focused layer id: layer-0");
  });
});
