import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  resolveOwnedProjectId: vi.fn(),
  assertRequestContentLength: vi.fn(),
  validateFiles: vi.fn(),
  withUserStorageQuota: vi.fn(),
  writeReferenceFile: vi.fn(),
  deleteStoredFile: vi.fn(),
  generationJobCreate: vi.fn(),
  assetCreate: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/project-ownership", () => ({
  resolveOwnedProjectId: mocks.resolveOwnedProjectId,
}));
vi.mock("@/lib/server/file-validation", () => ({
  assertRequestContentLength: mocks.assertRequestContentLength,
  validateFiles: mocks.validateFiles,
  withUserStorageQuota: mocks.withUserStorageQuota,
}));
vi.mock("@/lib/server/storage", () => ({
  writeReferenceFile: mocks.writeReferenceFile,
  deleteStoredFile: mocks.deleteStoredFile,
}));

import { POST } from "@/app/api/assets/upload/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
  mocks.resolveOwnedProjectId.mockResolvedValue("project-1");
  mocks.writeReferenceFile.mockResolvedValue({
    storagePath: "uploads/wide.webp",
    mimeType: "image/webp",
    byteSize: 1234,
    width: 1920,
    height: 1080,
    buffer: Buffer.from("image"),
  });
  mocks.generationJobCreate.mockResolvedValue({ id: "job-1" });
  mocks.assetCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "asset-1",
    ...data,
    projectId: data.projectId ?? null,
    modality: "IMAGE",
    format: null,
    durationSeconds: null,
    tags: [],
    isFavorite: false,
    note: null,
    summary: null,
    agentTaskId: null,
    parentAssetId: null,
    deletedAt: null,
    createdAt: new Date("2026-07-16T00:00:00.000Z"),
  }));
  mocks.withUserStorageQuota.mockImplementation(
    async (_userId: string, _bytes: number, operation: (tx: unknown) => unknown) =>
      operation({
        generationJob: { create: mocks.generationJobCreate },
        asset: { create: mocks.assetCreate },
      }),
  );
});

describe("asset upload dimensions", () => {
  it("persists and returns the decoded 16:9 dimensions", async () => {
    const form = new FormData();
    form.set("projectId", "project-1");
    form.set("file", new File(["image"], "wide.webp", { type: "image/webp" }));

    const response = await POST(
      new NextRequest("http://localhost/api/assets/upload", { method: "POST", body: form }),
    );

    expect(response.status).toBe(200);
    expect(mocks.assetCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ width: 1920, height: 1080 }),
    });
    await expect(response.json()).resolves.toMatchObject({
      asset: { width: 1920, height: 1080, modality: "IMAGE" },
    });
  });
});
