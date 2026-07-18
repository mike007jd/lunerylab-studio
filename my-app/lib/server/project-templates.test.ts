import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  projectFindMany: vi.fn(),
  projectCreate: vi.fn(),
  jobCreate: vi.fn(),
  assetCreate: vi.fn(),
  assetUpdate: vi.fn(),
  sessionCreate: vi.fn(),
  layerCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    project: {
      findFirst: mocks.projectFindFirst,
      findMany: mocks.projectFindMany,
    },
    $transaction: mocks.transaction,
  },
}));

import { cloneProjectTemplate, fetchProjectTemplates } from "@/lib/server/project-templates";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectCreate.mockResolvedValue({ id: "project-copy", name: "Copy", category: "STUDIO" });
  mocks.jobCreate.mockResolvedValue({ id: "job-copy" });
  mocks.assetCreate.mockResolvedValue({ id: "asset-copy" });
  mocks.transaction.mockImplementation(async (operation: (tx: unknown) => unknown) =>
    operation({
      project: { create: mocks.projectCreate },
      generationJob: { create: mocks.jobCreate },
      asset: { create: mocks.assetCreate, update: mocks.assetUpdate },
      canvasSession: { create: mocks.sessionCreate },
      canvasLayer: { create: mocks.layerCreate },
    }),
  );
});

describe("project templates", () => {
  it("exposes the stable template key for localized presentation", async () => {
    mocks.projectFindMany.mockResolvedValue([
      {
        id: "template-1",
        name: "Stored name",
        templateKey: "coffee-scene",
        _count: { assets: 1, canvasSessions: 1 },
        assets: [{ id: "asset-1" }],
      },
    ]);

    await expect(fetchProjectTemplates("user-1")).resolves.toEqual([
      expect.objectContaining({ templateKey: "coffee-scene" }),
    ]);
  });

  it("keeps cloned jobs and assets out of user generation history", async () => {
    mocks.projectFindFirst.mockResolvedValue({
      id: "template-1",
      name: "Template",
      templateKey: "coffee-scene",
      jobs: [{
        id: "job-1",
        source: "STUDIO",
        toolType: null,
        prompt: "Bundled sample prompt",
        referenceCount: 0,
        requestedCount: 1,
        successCount: 1,
        status: "SUCCEEDED",
        provider: "sample",
        model: "sample",
        errorCode: null,
        errorMessage: null,
        type: "image",
        videoDuration: null,
        completedAt: new Date("2026-07-01T00:00:00.000Z"),
      }],
      assets: [{
        id: "asset-1",
        jobId: "job-1",
        parentAssetId: null,
        kind: "GENERATED",
        modality: "IMAGE",
        storagePath: "generated/sample.webp",
        mimeType: "image/webp",
        byteSize: 10,
        width: 100,
        height: 100,
        format: null,
        durationSeconds: null,
        tags: [],
        note: null,
        summary: null,
      }],
      canvasSessions: [],
    });

    await cloneProjectTemplate({
      userId: "user-1",
      templateId: "template-1",
      name: "Copy",
      t: (path) => path,
    });

    expect(mocks.jobCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ origin: "TEMPLATE" }),
    });
    expect(mocks.assetCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ origin: "TEMPLATE" }),
    });
  });

  it("localizes the default clone name and bundled canvas title", async () => {
    mocks.projectFindFirst.mockResolvedValue({
      id: "template-1",
      name: "Stored template name",
      templateKey: "coffee-scene",
      jobs: [],
      assets: [],
      canvasSessions: [{
        id: "session-1",
        title: "Stored session title",
        zoom: 1,
        panX: 0,
        panY: 0,
        drawingState: {},
        selectedAssetId: null,
        layers: [],
      }],
    });
    const t = (path: string) => ({
      "samples.coffee-scene.projectName": "Localized template",
      "samples.coffee-scene.sessionTitle": "Localized canvas",
    })[path] ?? path;

    await cloneProjectTemplate({
      userId: "user-1",
      templateId: "template-1",
      t,
    });

    expect(mocks.projectCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Localized template" }),
    });
    expect(mocks.sessionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ title: "Localized canvas" }),
    });
  });
});
