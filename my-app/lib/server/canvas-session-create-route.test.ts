import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  resolveOwnedProjectId: vi.fn(),
  assetFindFirst: vi.fn(),
  projectFindFirst: vi.fn(),
  sessionCreate: vi.fn(),
  layerCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/project-ownership", () => ({
  resolveOwnedProjectId: mocks.resolveOwnedProjectId,
}));
vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    asset: { findFirst: mocks.assetFindFirst },
    project: { findFirst: mocks.projectFindFirst },
    $transaction: mocks.transaction,
  },
}));

import { POST } from "@/app/api/canvas/sessions/route";

const createdSession = {
  id: "session-1",
  projectId: "project-1",
  selectedAssetId: "asset-1",
  title: "Wide canvas",
  status: "EDITING",
  zoom: 1,
  panX: 0,
  panY: 0,
  createdAt: new Date("2026-07-16T00:00:00.000Z"),
  updatedAt: new Date("2026-07-16T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
  mocks.resolveOwnedProjectId.mockResolvedValue("project-1");
  mocks.projectFindFirst.mockResolvedValue({ isTemplate: false });
  mocks.assetFindFirst.mockResolvedValue({
    id: "asset-1",
    projectId: "project-1",
    width: 1920,
    height: 1080,
    project: { userId: "user-1", isTemplate: false },
  });
  mocks.sessionCreate.mockResolvedValue(createdSession);
  mocks.layerCreate.mockResolvedValue({ id: "layer-1" });
  mocks.transaction.mockImplementation(async (operation: (tx: unknown) => unknown) =>
    operation({
      canvasSession: { create: mocks.sessionCreate },
      canvasLayer: { create: mocks.layerCreate },
    }),
  );
});

function createRequest(extra: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/canvas/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: "project-1",
      title: "Wide canvas",
      assetId: "asset-1",
      ...extra,
    }),
  });
}

describe("canvas session image dimensions", () => {
  it("uses the Asset dimensions and ignores removed client overrides", async () => {
    const response = await POST(createRequest({ width: 1024, height: 1024 }));

    expect(response.status).toBe(201);
    expect(mocks.assetFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ modality: "IMAGE" }),
      }),
    );
    expect(mocks.layerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ width: 1920, height: 1080 }),
    });
  });

  it("rejects an image whose persisted dimensions violate the Asset contract", async () => {
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-1", width: null, height: null });

    const response = await POST(createRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "asset_dimensions_missing",
      retryable: false,
    });
    expect(mocks.layerCreate).not.toHaveBeenCalled();
  });
});

describe("canvas session asset project ownership", () => {
  it("adopts the owned asset project when the global Library omits projectId", async () => {
    mocks.resolveOwnedProjectId.mockResolvedValue(null);
    mocks.assetFindFirst.mockResolvedValue({
      id: "asset-1",
      projectId: "asset-project",
      width: 1920,
      height: 1080,
      project: { userId: "user-1", isTemplate: false },
    });

    const response = await POST(createRequest({ projectId: undefined }));

    expect(response.status).toBe(201);
    expect(mocks.sessionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ projectId: "asset-project" }),
    });
  });

  it("rejects an explicit project that conflicts with the asset project", async () => {
    mocks.assetFindFirst.mockResolvedValue({
      id: "asset-1",
      projectId: "other-project",
      width: 1920,
      height: 1080,
      project: { userId: "user-1", isTemplate: false },
    });

    const response = await POST(createRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "asset_project_mismatch",
      retryable: false,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("requires cloning an original template asset before opening it in Canvas", async () => {
    mocks.assetFindFirst.mockResolvedValue({
      id: "asset-1",
      projectId: "template-project",
      width: 1920,
      height: 1080,
      project: { userId: "user-1", isTemplate: true },
    });

    const response = await POST(createRequest({ projectId: undefined }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "template_asset_requires_clone",
      retryable: false,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("keeps the original template project read-only even without an asset", async () => {
    mocks.projectFindFirst.mockResolvedValue({ isTemplate: true });

    const response = await POST(createRequest({ assetId: undefined }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "template_project_read_only",
      retryable: false,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
