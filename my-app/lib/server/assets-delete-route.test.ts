import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  updateMany: vi.fn(),
  purgeAssets: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/prisma", () => ({
  prisma: { asset: { updateMany: mocks.updateMany } },
}));
vi.mock("@/lib/server/storage", () => ({
  getStoredFileMetadata: vi.fn(),
  streamStoredFile: vi.fn(),
}));
vi.mock("@/lib/server/sample-projects", () => ({
  restoreBundledSampleAssetStorage: vi.fn(),
}));
vi.mock("@/lib/server/asset-purge", () => ({
  purgeAssets: mocks.purgeAssets,
}));

import { DELETE } from "@/app/api/assets/[id]/route";

function deleteRequest(id: string, query = "") {
  return DELETE(new NextRequest(`http://localhost/api/assets/${id}${query}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.purgeAssets.mockResolvedValue({ purgedCount: 1, bytesFreed: 2048, filesDeleted: 1 });
});

describe("DELETE /api/assets/[id] soft delete", () => {
  it("moves the owned active asset to Trash without deleting its file or canvas layers", async () => {
    const response = await deleteRequest("asset-del");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: { id: "asset-del" } });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "asset-del", userId: "user-1", deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("returns 404 for a missing or already trashed asset", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const response = await deleteRequest("asset-missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "asset_not_found" });
  });
});

describe("DELETE /api/assets/[id]?permanent=true", () => {
  it("purges the asset row + file and reports bytes freed", async () => {
    const response = await deleteRequest("asset-perm", "?permanent=true");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deleted: { id: "asset-perm" },
      permanent: true,
      bytesFreed: 2048,
    });
    expect(mocks.purgeAssets).toHaveBeenCalledWith("user-1", ["asset-perm"]);
    // Permanent delete does NOT go through the soft-delete path.
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("returns 404 when the asset to purge does not exist", async () => {
    mocks.purgeAssets.mockResolvedValue({ purgedCount: 0, bytesFreed: 0, filesDeleted: 0 });

    const response = await deleteRequest("asset-gone", "?permanent=true");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "asset_not_found" });
  });
});
