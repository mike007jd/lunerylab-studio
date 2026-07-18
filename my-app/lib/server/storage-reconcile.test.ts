import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  isBlobStorage: vi.fn(),
  listStoredRelativePaths: vi.fn(),
  resolveStoragePath: vi.fn((p: string) => `/root/${p}`),
  deleteStoredFile: vi.fn(),
  access: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: { asset: { findMany: mocks.findMany } },
}));

vi.mock("@/lib/server/storage", () => ({
  isBlobStorage: mocks.isBlobStorage,
  listStoredRelativePaths: mocks.listStoredRelativePaths,
  resolveStoragePath: mocks.resolveStoragePath,
  deleteStoredFile: mocks.deleteStoredFile,
}));

vi.mock("node:fs/promises", () => ({
  default: { access: mocks.access },
}));

import { reconcileStorage } from "@/lib/server/storage-reconcile";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isBlobStorage.mockReturnValue(false);
  mocks.deleteStoredFile.mockResolvedValue(undefined);
});

describe("reconcileStorage", () => {
  it("is a no-op for blob storage", async () => {
    mocks.isBlobStorage.mockReturnValue(true);
    const result = await reconcileStorage("user-1");
    expect(result.supported).toBe(false);
    expect(mocks.listStoredRelativePaths).not.toHaveBeenCalled();
  });

  it("reports missing files and orphan files without deleting by default", async () => {
    // active assets (missing-file scope)
    mocks.findMany.mockResolvedValueOnce([
      { id: "a1", storagePath: "generated/a1.png" }, // present
      { id: "a2", storagePath: "generated/a2.png" }, // missing
    ]);
    // all asset paths (orphan reference set) — includes a trashed asset's file
    mocks.findMany.mockResolvedValueOnce([
      { storagePath: "generated/a1.png" },
      { storagePath: "generated/a2.png" },
      { storagePath: "uploads/trashed.png" },
    ]);
    mocks.listStoredRelativePaths.mockResolvedValue([
      "generated/a1.png",
      "uploads/trashed.png",
      "generated/orphan.png", // no owning row
    ]);
    // a1 exists, a2 does not
    mocks.access.mockImplementation(async (p: string) =>
      p === "/root/generated/a1.png" ? undefined : Promise.reject(new Error("ENOENT")),
    );

    const result = await reconcileStorage("user-1");

    expect(result.missingFiles).toEqual(["a2"]);
    expect(result.orphanFiles).toEqual(["generated/orphan.png"]);
    expect(result.orphansDeleted).toBe(0);
    expect(mocks.deleteStoredFile).not.toHaveBeenCalled();
  });

  it("deletes orphan files when deleteOrphans is set", async () => {
    mocks.findMany.mockResolvedValueOnce([]); // no active assets
    mocks.findMany.mockResolvedValueOnce([]); // no referenced paths
    mocks.listStoredRelativePaths.mockResolvedValue(["generated/orphan.png"]);

    const result = await reconcileStorage("user-1", { deleteOrphans: true });

    expect(result.orphanFiles).toEqual(["generated/orphan.png"]);
    expect(result.orphansDeleted).toBe(1);
    expect(mocks.deleteStoredFile).toHaveBeenCalledWith("generated/orphan.png");
  });
});
