import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  stageStoredFileDeletion: vi.fn(),
  rollbackStoredFileDeletion: vi.fn(),
  commitStoredFileDeletion: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    asset: {
      findMany: mocks.findMany,
      deleteMany: mocks.deleteMany,
    },
  },
}));

vi.mock("@/lib/server/storage", () => ({
  stageStoredFileDeletion: mocks.stageStoredFileDeletion,
  rollbackStoredFileDeletion: mocks.rollbackStoredFileDeletion,
  commitStoredFileDeletion: mocks.commitStoredFileDeletion,
}));

import { purgeAssets } from "@/lib/server/asset-purge";
import {
  getWorkspaceOperationGateStateForTests,
  resetWorkspaceOperationGateForTests,
  withWorkspaceExclusive,
} from "@/lib/server/workspace-operation-gate";

beforeEach(() => {
  resetWorkspaceOperationGateForTests();
  vi.clearAllMocks();
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.stageStoredFileDeletion.mockImplementation(async (storagePath: string) => ({
    storagePath,
    stagedStoragePath: `${storagePath}.lunery-purge`,
    hadFile: true,
  }));
  mocks.rollbackStoredFileDeletion.mockResolvedValue(undefined);
  mocks.commitStoredFileDeletion.mockResolvedValue(undefined);
});

afterEach(() => {
  resetWorkspaceOperationGateForTests();
});

describe("purgeAssets", () => {
  it("returns zero and does nothing when there are no targets", async () => {
    mocks.findMany.mockResolvedValueOnce([]);

    const result = await purgeAssets("user-1", "trash");

    expect(result).toEqual({ purgedCount: 0, bytesFreed: 0, filesDeleted: 0 });
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.stageStoredFileDeletion).not.toHaveBeenCalled();
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
    expect(result.bytesFreed).toBe(100);
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a1", "a2"] }, userId: "user-1" } });
    // Only the non-shared file is unlinked.
    expect(mocks.stageStoredFileDeletion).toHaveBeenCalledTimes(1);
    expect(mocks.stageStoredFileDeletion).toHaveBeenCalledWith("gen/a1.png");
    expect(mocks.commitStoredFileDeletion).toHaveBeenCalledTimes(1);
    expect(result.filesDeleted).toBe(1);
  });

  it("keeps directly deleted assets visible when a stored file cannot be staged", async () => {
    mocks.findMany.mockResolvedValueOnce([
      { id: "a1", storagePath: "generated/a1.png", byteSize: 100 },
    ]);
    mocks.findMany.mockResolvedValueOnce([]);
    mocks.stageStoredFileDeletion.mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );

    await expect(purgeAssets("user-1", ["a1"])).rejects.toMatchObject({
      code: "asset_file_delete_failed",
      retryable: true,
    });

    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("restores staged files when row deletion fails", async () => {
    mocks.findMany.mockResolvedValueOnce([
      { id: "a1", storagePath: "generated/a1.png", byteSize: 100 },
    ]);
    mocks.findMany.mockResolvedValueOnce([]);
    mocks.deleteMany.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(purgeAssets("user-1", ["a1"])).rejects.toMatchObject({
      code: "asset_record_delete_failed",
      retryable: true,
    });

    expect(mocks.stageStoredFileDeletion).toHaveBeenCalledWith("generated/a1.png");
    expect(mocks.rollbackStoredFileDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ storagePath: "generated/a1.png" }),
    );
    expect(mocks.commitStoredFileDeletion).not.toHaveBeenCalled();
  });

  it("restores every staged file so a partial multi-file failure can be retried", async () => {
    const targets = [
      { id: "a1", storagePath: "generated/a1.png", byteSize: 100 },
      { id: "a2", storagePath: "generated/a2.png", byteSize: 200 },
    ];
    mocks.findMany
      .mockResolvedValueOnce(targets)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(targets)
      .mockResolvedValueOnce([]);
    mocks.stageStoredFileDeletion
      .mockResolvedValueOnce({
        storagePath: "generated/a1.png",
        stagedStoragePath: "generated/a1.png.lunery-purge",
        hadFile: true,
      })
      .mockRejectedValueOnce(new Error("volume busy"));

    await expect(purgeAssets("user-1", ["a1", "a2"])).rejects.toMatchObject({
      code: "asset_file_delete_failed",
      retryable: true,
    });
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.rollbackStoredFileDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ storagePath: "generated/a1.png" }),
    );

    await expect(purgeAssets("user-1", ["a1", "a2"])).resolves.toMatchObject({
      purgedCount: 2,
      filesDeleted: 2,
    });
    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.commitStoredFileDeletion).toHaveBeenCalledTimes(2);
  });

  it("deletes asset rows so ReferenceSetAsset memberships cascade away", async () => {
    mocks.findMany.mockResolvedValueOnce([{ id: "a1", storagePath: "gen/a1.png", byteSize: 10 }]);
    mocks.findMany.mockResolvedValueOnce([]); // no survivors share the path

    await purgeAssets("user-1", ["a1"]);

    // Reference reconciliation is now handled by the join table's onDelete
    // Cascade FK — purge just removes the asset rows.
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a1"] }, userId: "user-1" } });
  });

  it("holds one shared lease from file staging through row deletion and file commit", async () => {
    mocks.findMany.mockResolvedValueOnce([
      { id: "a1", storagePath: "generated/a1.png", byteSize: 10 },
    ]);
    mocks.findMany.mockResolvedValueOnce([]);
    let releaseStage!: () => void;
    let stageStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stageStarted = resolve;
    });
    mocks.stageStoredFileDeletion.mockImplementationOnce(async (storagePath: string) => {
      stageStarted();
      await new Promise<void>((resolve) => {
        releaseStage = resolve;
      });
      return {
        storagePath,
        stagedStoragePath: `${storagePath}.lunery-purge`,
        hadFile: true,
      };
    });

    const purge = purgeAssets("user-1", ["a1"]);
    await started;
    let exclusiveEntered = false;
    const exclusive = withWorkspaceExclusive("backup", async () => {
      exclusiveEntered = true;
    });
    await vi.waitFor(() => {
      expect(getWorkspaceOperationGateStateForTests().exclusivePending).toBe(true);
    });
    expect(exclusiveEntered).toBe(false);

    releaseStage();
    await purge;
    expect(mocks.deleteMany).toHaveBeenCalledOnce();
    expect(mocks.commitStoredFileDeletion).toHaveBeenCalledOnce();
    await exclusive;
    expect(exclusiveEntered).toBe(true);
  });
});
