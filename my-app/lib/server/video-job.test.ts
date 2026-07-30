import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  beginDetachedVideoWork,
  getWorkspaceOperationGateStateForTests,
  resetWorkspaceOperationGateForTests,
} from "@/lib/server/workspace-operation-gate";

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
  resetWorkspaceOperationGateForTests();
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
    const admission = beginDetachedVideoWork();
    await runVideoJob({
      ...baseInput,
      runtime: { backend: "byok", providerId: "fal", modelId: "frozen-model", warnings: [] },
      workspaceAdmission: admission,
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
    expect(getWorkspaceOperationGateStateForTests().activeVideoCount).toBe(0);
  });

  it("fails the job (no provider call) when the frozen backend is none", async () => {
    const admission = beginDetachedVideoWork();
    await runVideoJob({
      ...baseInput,
      runtime: { backend: "none", warnings: [] },
      workspaceAdmission: admission,
    });

    expect(mocks.generateVideoByok).not.toHaveBeenCalled();
    expect(mocks.failRunningGenerationJob).toHaveBeenCalled();
    expect(getWorkspaceOperationGateStateForTests().activeVideoCount).toBe(0);
  });

  it("releases the transferred admission after terminal success and failure paths", async () => {
    const successAdmission = beginDetachedVideoWork();
    await runVideoJob({
      ...baseInput,
      runtime: { backend: "byok", providerId: "fal", modelId: "frozen-model", warnings: [] },
      workspaceAdmission: successAdmission,
    });
    expect(getWorkspaceOperationGateStateForTests().activeVideoCount).toBe(0);

    const failureAdmission = beginDetachedVideoWork();
    mocks.generateVideoByok.mockRejectedValueOnce(new Error("provider down"));
    await runVideoJob({
      ...baseInput,
      runtime: { backend: "byok", providerId: "fal", modelId: "frozen-model", warnings: [] },
      workspaceAdmission: failureAdmission,
    });
    expect(mocks.failRunningGenerationJob).toHaveBeenCalled();
    expect(getWorkspaceOperationGateStateForTests().activeVideoCount).toBe(0);
  });

  it("rejects a forgeable boolean stand-in and does not call the provider", async () => {
    await runVideoJob({
      ...baseInput,
      runtime: { backend: "byok", providerId: "fal", modelId: "frozen-model", warnings: [] },
      // @ts-expect-error — forgeable boolean must not satisfy admission.
      workspaceAdmission: true,
    });
    expect(mocks.generateVideoByok).not.toHaveBeenCalled();
    expect(mocks.failRunningGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: "video_admission_invalid" }),
      }),
    );
  });

  it("rejects an object forged with the old global-symbol shape", async () => {
    const forgedAdmission = {
      [Symbol.for("lunery.detachedVideoAdmission")]: true,
      release: vi.fn(),
    };
    await runVideoJob({
      ...baseInput,
      runtime: { backend: "byok", providerId: "fal", modelId: "frozen-model", warnings: [] },
      // @ts-expect-error — only beginDetachedVideoWork can mint an admission.
      workspaceAdmission: forgedAdmission,
    });

    expect(mocks.generateVideoByok).not.toHaveBeenCalled();
    expect(forgedAdmission.release).not.toHaveBeenCalled();
    expect(mocks.failRunningGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: "video_admission_invalid" }),
      }),
    );
  });
});
