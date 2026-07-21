import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  writeGeneratedImage: vi.fn(),
  deleteStoredFile: vi.fn(),
  withAssetWriteTransaction: vi.fn(),
  assetCreate: vi.fn(),
  txLayerUpdate: vi.fn(),
  txLayerAggregate: vi.fn(),
  txLayerCreate: vi.fn(),
  assetDeleteMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/server/storage", () => ({
  writeGeneratedImage: mocks.writeGeneratedImage,
  deleteStoredFile: mocks.deleteStoredFile,
}));
vi.mock("@/lib/server/file-validation", () => ({
  withAssetWriteTransaction: mocks.withAssetWriteTransaction,
}));
vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    asset: { deleteMany: mocks.assetDeleteMany },
  },
}));

import { saveResultAsReplacementLayer } from "@/lib/server/agent/v2/replacement-layer";
import type { AgentToolContext } from "@/lib/server/agent/v2/tool-registry";

const ctx = {
  userId: "user-1",
  projectId: "proj-1",
  sessionId: "sess-1",
} as unknown as AgentToolContext;
const source = { id: "layer-src", x: 0, y: 0, width: 100, height: 100 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeGeneratedImage.mockResolvedValue({
    storagePath: "stored/path.png",
    mimeType: "image/png",
    byteSize: 1234,
    width: 1920,
    height: 1080,
  });
  mocks.assetCreate.mockResolvedValue({ id: "asset-new" });
  mocks.withAssetWriteTransaction.mockImplementation(
    async (operation: (tx: unknown) => unknown) =>
      operation({ asset: { create: mocks.assetCreate } }),
  );
  mocks.deleteStoredFile.mockResolvedValue(undefined);
  mocks.assetDeleteMany.mockResolvedValue({ count: 1 });
  mocks.txLayerAggregate.mockResolvedValue({ _max: { zIndex: 4 } });
  // The real prisma.$transaction runs the callback atomically; here we just
  // forward a tx whose canvasLayer ops are the mocked fns.
  mocks.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      canvasLayer: {
        update: mocks.txLayerUpdate,
        aggregate: mocks.txLayerAggregate,
        create: mocks.txLayerCreate,
      },
    }),
  );
});

describe("saveResultAsReplacementLayer (#3)", () => {
  it("hides the source + creates the replacement layer inside one transaction", async () => {
    mocks.txLayerCreate.mockResolvedValue({ id: "layer-new" });

    const result = await saveResultAsReplacementLayer(
      ctx,
      source,
      Buffer.from("x"),
      "job-1",
    );

    expect(result).toEqual({ assetId: "asset-new", layerId: "layer-new" });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.withAssetWriteTransaction).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.assetCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ width: 1920, height: 1080 }),
    });
    // hide-original and create both run through the transaction → atomic.
    expect(mocks.txLayerUpdate).toHaveBeenCalledWith({
      where: { id: "layer-src" },
      data: { hidden: true },
    });
    expect(mocks.txLayerCreate).toHaveBeenCalledTimes(1);
    // Happy path performs no rollback cleanup.
    expect(mocks.assetDeleteMany).not.toHaveBeenCalled();
    expect(mocks.deleteStoredFile).not.toHaveBeenCalled();
  });

  it("rolls back the hide and cleans up the orphan asset + file when create fails", async () => {
    mocks.txLayerCreate.mockRejectedValue(new Error("db down"));

    await expect(
      saveResultAsReplacementLayer(ctx, source, Buffer.from("x"), "job-1"),
    ).rejects.toThrow("db down");

    // The hide + create were issued through the SAME transaction, so the
    // `hidden: true` flag rolls back with it (source layer stays visible).
    expect(mocks.txLayerUpdate).toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    // The new (now-orphaned) asset row + stored file are cleaned up.
    expect(mocks.assetDeleteMany).toHaveBeenCalledWith({
      where: { id: "asset-new", userId: "user-1" },
    });
    expect(mocks.deleteStoredFile).toHaveBeenCalledWith("stored/path.png");
  });
});
