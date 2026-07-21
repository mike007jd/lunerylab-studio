import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  generateVideoByok: vi.fn(),
  writeGeneratedVideo: vi.fn(),
  deleteStoredFile: vi.fn(),
  withAssetWriteTransaction: vi.fn(),
  completeGenerationJob: vi.fn(),
  failRunningGenerationJob: vi.fn(),
  assetDeleteMany: vi.fn(),
  txAssetCreate: vi.fn(),
}));

vi.mock("@/lib/server/byok-video", () => ({ generateVideoByok: mocks.generateVideoByok }));
vi.mock("@/lib/server/storage", () => ({
  writeGeneratedVideo: mocks.writeGeneratedVideo,
  deleteStoredFile: mocks.deleteStoredFile,
}));
vi.mock("@/lib/server/file-validation", () => ({
  withAssetWriteTransaction: mocks.withAssetWriteTransaction,
}));
vi.mock("@/lib/server/generation-job", () => ({
  completeGenerationJob: mocks.completeGenerationJob,
  failRunningGenerationJob: mocks.failRunningGenerationJob,
}));
vi.mock("@/lib/server/prisma", () => ({
  prisma: { asset: { deleteMany: mocks.assetDeleteMany } },
}));

import { runVideoJob } from "@/lib/server/video-job";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateVideoByok.mockResolvedValue({
    provider: "byok:fal",
    model: "frozen-model",
    video: { bytes: Buffer.from("v"), mimeType: "video/mp4" },
  });
  mocks.writeGeneratedVideo.mockResolvedValue({
    storagePath: "generated/v.mp4",
    mimeType: "video/mp4",
    byteSize: 10,
  });
  // Asset creation and job completion run inside the write transaction, so
  // the mock must invoke the callback with a fake tx client.
  mocks.txAssetCreate.mockResolvedValue({ id: "asset-1" });
  mocks.withAssetWriteTransaction.mockImplementation(async (write) =>
    write({ asset: { create: mocks.txAssetCreate } }),
  );
  mocks.completeGenerationJob.mockResolvedValue({});
  mocks.deleteStoredFile.mockResolvedValue(undefined);
});

const baseInput = {
  jobId: "job-1",
  userId: "user-1",
  projectId: null,
  // The catalog/selection id the user submitted with — must NOT be what the
  // runner sends to the provider; the frozen runtime wins.
  modelId: "byok:fal:catalog-id",
  prompt: "a clip",
  durationSeconds: 6,
};

describe("runVideoJob model freeze (#8)", () => {
  it("uses the provider/model frozen at submission, not a re-resolved one", async () => {
    await runVideoJob({
      ...baseInput,
      runtime: { backend: "byok", providerId: "fal", modelId: "frozen-model", warnings: [] },
    });

    // The runner dispatched to the FROZEN provider + model id, ignoring any
    // later Settings change that would have re-resolved differently.
    expect(mocks.generateVideoByok).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "frozen-model", prompt: "a clip", durationSeconds: 6 }),
      "fal",
    );
    expect(mocks.completeGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1", model: "frozen-model" }),
    );
    expect(mocks.failRunningGenerationJob).not.toHaveBeenCalled();
  });

  it("fails the job (no provider call) when the frozen backend is none", async () => {
    await runVideoJob({
      ...baseInput,
      runtime: { backend: "none", warnings: [] },
    });

    expect(mocks.generateVideoByok).not.toHaveBeenCalled();
    expect(mocks.failRunningGenerationJob).toHaveBeenCalled();
  });
});
