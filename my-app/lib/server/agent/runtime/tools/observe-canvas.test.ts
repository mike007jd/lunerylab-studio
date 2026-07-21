import { describe, expect, it, vi } from "vitest";
import type { AgentToolContext } from "@/lib/server/agent/runtime/tool-registry";
import type { CanvasSnapshot } from "@/lib/server/agent/runtime/canvas-serializer";

vi.mock("server-only", () => ({}));

import { buildObserveCanvasTool } from "@/lib/server/agent/runtime/tools/observe-canvas";

function snapshot(): CanvasSnapshot {
  return {
    sessionId: "session-1",
    projectId: "project-1",
    title: "Large canvas",
    layerCount: 50,
    selectedLayerId: null,
    layers: Array.from({ length: 50 }, (_, index) => ({
      id: `layer-${index}`,
      index,
      assetId: `asset-${index}`,
      assetKind: "GENERATED",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      zIndex: index,
      hidden: false,
      locked: false,
      selected: false,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    })),
    annotationCount: 0,
    annotationText: [],
    defaultReferenceSet: null,
  } as CanvasSnapshot;
}

describe("observe_canvas", () => {
  it("returns a bounded requested page with navigation metadata", async () => {
    const ctx = {
      snapshot: snapshot(),
      refreshSnapshot: vi.fn(async () => undefined),
      recordStep: vi.fn(),
      nextStepIndex: vi.fn(() => 0),
    } as unknown as AgentToolContext;
    const execute = buildObserveCanvasTool(ctx).execute as unknown as (input: {
      startIndex: number;
      limit: number;
    }) => Promise<Record<string, unknown>>;

    const result = await execute({ startIndex: 10, limit: 5 });

    expect(result).toMatchObject({
      ok: true,
      layerCount: 50,
      includedLayerCount: 5,
      omittedLayerCount: 45,
      nextStartIndex: 15,
    });
    expect(result.canvas).toContain("id=layer-10");
    expect(result.canvas).not.toContain("id=layer-9 ");
    expect(result.canvas).not.toContain("id=layer-15 ");
  });
});
