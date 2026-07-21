import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolContext } from "@/lib/server/agent/runtime/tool-registry";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    canvasLayer: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/server/prisma";
import { buildSetLayerVisibilityTool } from "@/lib/server/agent/runtime/tools/canvas-ops";

interface VisibilityInput {
  layerId: string;
  hidden?: boolean;
  locked?: boolean;
}

interface VisibilityResult {
  ok: boolean;
  error?: string;
}

const findFirst = vi.mocked(prisma.canvasLayer.findFirst);
const update = vi.mocked(prisma.canvasLayer.update);

function layer(locked: boolean) {
  return {
    id: "layer-1",
    sessionId: "session-1",
    assetId: "asset-1",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 0,
    locked,
    asset: {
      modality: "IMAGE",
      mimeType: "image/png",
      storagePath: "generated/layer.png",
    },
  };
}

function ctx(): AgentToolContext {
  return {
    userId: "user-1",
    sessionId: "session-1",
    projectId: "project-1",
    locale: "en",
    region: null,
    maskAssetId: null,
    uiContext: {
      selectedModelId: "model-1",
      selectedAspectRatio: "1:1",
      selectedCount: 1,
      generationMode: "image",
    },
    supply: {} as AgentToolContext["supply"],
    snapshot: {} as AgentToolContext["snapshot"],
    refreshSnapshot: vi.fn(async () => undefined),
    recordStep: vi.fn(),
    collectArtifacts: vi.fn(),
    nextStepIndex: vi.fn(() => 0),
  };
}

function execute(input: VisibilityInput): Promise<VisibilityResult> {
  const tool = buildSetLayerVisibilityTool(ctx());
  const run = tool.execute as unknown as (value: VisibilityInput) => Promise<VisibilityResult>;
  return run(input);
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({ id: "layer-1" } as never);
});

describe("set_layer_visibility", () => {
  it("allows a locked layer to be unlocked", async () => {
    findFirst.mockResolvedValue(layer(true) as never);

    await expect(execute({ layerId: "layer-1", locked: false })).resolves.toMatchObject({
      ok: true,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "layer-1" },
      data: { locked: false },
    });
  });

  it("keeps hidden-only changes blocked on locked layers", async () => {
    findFirst.mockResolvedValue(layer(true) as never);

    await expect(execute({ layerId: "layer-1", hidden: true })).resolves.toMatchObject({
      ok: false,
      error: "Layer layer-1 is locked and cannot be changed by the agent.",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("allows unlocking and changing visibility in the same operation", async () => {
    findFirst.mockResolvedValue(layer(true) as never);

    await expect(execute({ layerId: "layer-1", locked: false, hidden: true })).resolves.toMatchObject({
      ok: true,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "layer-1" },
      data: { hidden: true, locked: false },
    });
  });
});
