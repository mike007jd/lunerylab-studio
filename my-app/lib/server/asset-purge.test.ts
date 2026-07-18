import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  deleteStoredFile: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    asset: { findMany: mocks.findMany, deleteMany: mocks.deleteMany },
  },
}));

vi.mock("@/lib/server/storage", () => ({
  deleteStoredFile: mocks.deleteStoredFile,
}));

import { purgeAssets } from "@/lib/server/asset-purge";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.deleteStoredFile.mockResolvedValue(undefined);
});

describe("purgeAssets", () => {
  it("returns zero and does nothing when there are no targets", async () => {
    mocks.findMany.mockResolvedValueOnce([]);

    const result = await purgeAssets("user-1", "trash");

    expect(result).toEqual({ purgedCount: 0, bytesFreed: 0, filesDeleted: 0 });
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.deleteStoredFile).not.toHaveBeenCalled();
  });

  it("deletes rows and files, reclaims bytes, but skips files shared by a survivor", async () => {
    // targets query
    mocks.findMany.mockResolvedValueOnce([
      { id: "a1", storagePath: "gen/a1.png", byteSize: 100 },
      { id: "a2", storagePath: "shared.png", byteSize: 50 },
    ]);
    // survivors-using-paths query: another live asset still uses shared.png
    mocks.findMany.mockResolvedValueOnce([{ storagePath: "shared.png" }]);

    const result = await purgeAssets("user-1", ["a1", "a2"]);

    expect(result.purgedCount).toBe(2);
    expect(result.bytesFreed).toBe(150);
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a1", "a2"] }, userId: "user-1" } });
    // Only the non-shared file is unlinked.
    expect(mocks.deleteStoredFile).toHaveBeenCalledTimes(1);
    expect(mocks.deleteStoredFile).toHaveBeenCalledWith("gen/a1.png");
    expect(result.filesDeleted).toBe(1);
  });

  it("deletes asset rows so ReferenceSetAsset memberships cascade away", async () => {
    mocks.findMany.mockResolvedValueOnce([{ id: "a1", storagePath: "gen/a1.png", byteSize: 10 }]);
    mocks.findMany.mockResolvedValueOnce([]); // no survivors share the path

    await purgeAssets("user-1", ["a1"]);

    // Reference reconciliation is now handled by the join table's onDelete
    // Cascade FK — purge just removes the asset rows.
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a1"] }, userId: "user-1" } });
  });
});
