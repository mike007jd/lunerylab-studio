import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolContext } from "@/lib/server/agent/v2/tool-registry";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  generateImages: vi.fn(),
  resolveImageModelForGeneration: vi.fn(),
  createGenerationJob: vi.fn(),
  completeGenerationJob: vi.fn(),
  failRunningGenerationJob: vi.fn(),
  loadImageReferenceFiles: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    canvasLayer: { findMany: mocks.findMany },
  },
}));

vi.mock("@/lib/server/image-generate", () => ({
  generateImages: mocks.generateImages,
}));

vi.mock("@/lib/server/resolve-image-model", () => ({
  resolveImageModelForGeneration: mocks.resolveImageModelForGeneration,
}));

vi.mock("@/lib/server/generation-job", () => ({
  createGenerationJob: mocks.createGenerationJob,
  completeGenerationJob: mocks.completeGenerationJob,
  failRunningGenerationJob: mocks.failRunningGenerationJob,
}));

vi.mock("@/lib/server/reference-assets", () => ({
  loadImageReferenceFiles: mocks.loadImageReferenceFiles,
}));

import { buildGenerateImageTool } from "@/lib/server/agent/v2/tools/generate-image";

interface GenerateImageToolInput {
  prompt: string;
  count?: number;
  aspectRatio?: string;
  modelId?: string;
  useReferences?: boolean;
}

interface GenerateImageToolResult {
  ok: boolean;
  error?: string;
}

function createContext(): AgentToolContext {
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

function execute(input: GenerateImageToolInput): Promise<GenerateImageToolResult> {
  const run = buildGenerateImageTool(createContext()).execute as unknown as (
    value: GenerateImageToolInput,
  ) => Promise<GenerateImageToolResult>;
  return run(input);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
  mocks.resolveImageModelForGeneration.mockResolvedValue({ model: { id: "model-1" } });
  mocks.createGenerationJob.mockResolvedValue({ id: "job-1" });
  mocks.completeGenerationJob.mockResolvedValue({});
  mocks.failRunningGenerationJob.mockResolvedValue({});
  mocks.loadImageReferenceFiles.mockResolvedValue([]);
  mocks.generateImages.mockRejectedValue(new Error("provider reached"));
});

describe("generate_image input boundaries", () => {
  it("rejects an unsupported aspect ratio before resolving a model or provider", async () => {
    await expect(
      execute({ prompt: "Generate a studio portrait", aspectRatio: "2:1", useReferences: false }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Unsupported aspect ratio "2:1"'),
    });

    expect(mocks.resolveImageModelForGeneration).not.toHaveBeenCalled();
    expect(mocks.generateImages).not.toHaveBeenCalled();
    expect(mocks.createGenerationJob).not.toHaveBeenCalled();
  });

  it("rejects more than four unique references before reading files", async () => {
    mocks.findMany.mockResolvedValue(
      ["asset-1", "asset-2", "asset-3", "asset-4", "asset-5"].map((assetId) => ({ assetId })),
    );

    await expect(execute({ prompt: "Generate from canvas references" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("At most 4 reference images"),
    });

    expect(mocks.loadImageReferenceFiles).not.toHaveBeenCalled();
    expect(mocks.createGenerationJob).not.toHaveBeenCalled();
    expect(mocks.generateImages).not.toHaveBeenCalled();
  });

  it("deduplicates references so job accounting matches provider input", async () => {
    mocks.findMany.mockResolvedValue(
      ["asset-1", "asset-1", "asset-2", "asset-3"].map((assetId) => ({ assetId })),
    );
    mocks.loadImageReferenceFiles.mockImplementation(async ({ assetIds }: { assetIds: string[] }) =>
      assetIds.map((assetId) => ({ asset: { id: assetId }, bytes: Buffer.from(assetId) })),
    );

    await expect(execute({ prompt: "Generate from canvas references" })).resolves.toMatchObject({
      ok: false,
      error: "provider reached",
    });

    expect(mocks.loadImageReferenceFiles).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: ["asset-1", "asset-2", "asset-3"] }),
    );
    expect(mocks.createGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({ referenceCount: 3 }),
    );
    expect(mocks.generateImages).toHaveBeenCalledWith(
      expect.objectContaining({ references: expect.any(Array) }),
    );
    expect(mocks.generateImages.mock.calls[0]?.[0].references).toHaveLength(3);
  });
});
