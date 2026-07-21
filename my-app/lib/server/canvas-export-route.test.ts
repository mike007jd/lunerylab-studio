import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  requireWritableCanvasSession: vi.fn(),
  assertRequestContentLength: vi.fn(),
  validateFiles: vi.fn(),
  withAssetWriteTransaction: vi.fn(),
  exportForPlatforms: vi.fn(),
  writeGeneratedImage: vi.fn(),
  writeFilesOrCleanup: vi.fn(),
  deleteStoredFile: vi.fn(),
  createGenerationJob: vi.fn(),
  completeGenerationJob: vi.fn(),
  failRunningGenerationJob: vi.fn(),
  assetCreate: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/canvas-session-access", () => ({
  requireWritableCanvasSession: mocks.requireWritableCanvasSession,
}));
vi.mock("@/lib/server/file-validation", () => ({
  assertRequestContentLength: mocks.assertRequestContentLength,
  validateFiles: mocks.validateFiles,
  withAssetWriteTransaction: mocks.withAssetWriteTransaction,
}));
vi.mock("@/lib/server/platform-export", () => ({
  exportForPlatforms: mocks.exportForPlatforms,
}));
vi.mock("@/lib/server/storage", () => ({
  writeGeneratedImage: mocks.writeGeneratedImage,
  writeFilesOrCleanup: mocks.writeFilesOrCleanup,
  deleteStoredFile: mocks.deleteStoredFile,
}));
vi.mock("@/lib/server/generation-job", () => ({
  createGenerationJob: mocks.createGenerationJob,
  completeGenerationJob: mocks.completeGenerationJob,
  failRunningGenerationJob: mocks.failRunningGenerationJob,
}));
vi.mock("@/lib/server/dto", () => ({
  toAssetDTO: (asset: { id: string; mimeType: string }) => ({
    id: asset.id,
    mimeType: asset.mimeType,
    url: `/api/assets/${asset.id}`,
  }),
}));

import { POST } from "@/app/api/canvas/sessions/[id]/export/route";

const storedPng = {
  storagePath: "generated/project-1/export.png",
  mimeType: "image/png",
  byteSize: 100,
  width: 1200,
  height: 800,
};

function requestFor(mode: "original" | "platforms", presetIds: string[] = []) {
  const formData = new FormData();
  formData.set("source", new File([new Uint8Array([1, 2, 3])], "canvas.png", { type: "image/png" }));
  formData.set("mode", mode);
  presetIds.forEach((presetId) => formData.append("presetIds", presetId));
  return new NextRequest("http://localhost/api/canvas/sessions/session-1/export", {
    method: "POST",
    body: formData,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
  mocks.requireWritableCanvasSession.mockResolvedValue({ id: "session-1", projectId: "project-1" });
  mocks.createGenerationJob.mockResolvedValue({ id: "job-1" });
  mocks.writeGeneratedImage.mockResolvedValue(storedPng);
  mocks.writeFilesOrCleanup.mockImplementation(async (writers: Array<() => Promise<unknown>>) =>
    Promise.all(writers.map((writer) => writer())),
  );
  mocks.assetCreate.mockResolvedValue({ id: "asset-1", mimeType: "image/png" });
  mocks.withAssetWriteTransaction.mockImplementation(async (
    operation: (tx: unknown) => Promise<unknown>,
  ) => operation({ asset: { create: mocks.assetCreate } }));
});

describe("Canvas export route", () => {
  it("stores an original-size PNG through the generated-media path", async () => {
    const response = await POST(requestFor("original"), {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.exportForPlatforms).not.toHaveBeenCalled();
    expect(mocks.writeGeneratedImage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      bytes: Buffer.from([1, 2, 3]),
    }));
    expect(mocks.assetCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        projectId: "project-1",
        jobId: "job-1",
        kind: "GENERATED",
      }),
    });
    await expect(response.json()).resolves.toMatchObject({
      exports: [{ id: "asset-1", presetId: "original", downloadName: "lunery-canvas-original.png" }],
    });
  });

  it("uses the shared platform presets for a batch export", async () => {
    mocks.exportForPlatforms.mockResolvedValue([
      { presetId: "ig-post-square", bytes: Buffer.from([4]), mimeType: "image/jpeg", width: 1080, height: 1080 },
      { presetId: "ig-story", bytes: Buffer.from([5]), mimeType: "image/jpeg", width: 1080, height: 1920 },
    ]);
    mocks.writeGeneratedImage
      .mockResolvedValueOnce({ ...storedPng, mimeType: "image/jpeg" })
      .mockResolvedValueOnce({ ...storedPng, mimeType: "image/jpeg" });
    mocks.assetCreate
      .mockResolvedValueOnce({ id: "asset-1", mimeType: "image/jpeg" })
      .mockResolvedValueOnce({ id: "asset-2", mimeType: "image/jpeg" });

    const response = await POST(requestFor("platforms", ["ig-post-square", "ig-story"]), {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.exportForPlatforms).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3]),
      ["ig-post-square", "ig-story"],
      { fit: "cover" },
    );
    expect(mocks.completeGenerationJob).toHaveBeenCalledWith(expect.objectContaining({
      successCount: 2,
      requestedCount: 2,
    }));
  });

  it("rejects an empty or unknown platform selection before creating a job", async () => {
    const empty = await POST(requestFor("platforms"), {
      params: Promise.resolve({ id: "session-1" }),
    });
    const unknown = await POST(requestFor("platforms", ["unknown-size"]), {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(empty.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(mocks.createGenerationJob).not.toHaveBeenCalled();
  });
});
