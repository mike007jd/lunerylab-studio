import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    generationJob: { updateMany: mocks.updateMany, findUnique: mocks.findUnique },
  },
}));

import { completeGenerationJob, failRunningGenerationJob } from "@/lib/server/generation-job";
import { ApiError } from "@/lib/server/errors";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.findUnique.mockResolvedValue({ id: "job-1" });
});

describe("completeGenerationJob provenance", () => {
  it("persists the concrete endpoint that served the request", async () => {
    await completeGenerationJob({
      jobId: "job-1",
      model: "sd_xl_base_1.0",
      provider: "local-comfyui",
      endpoint: "http://127.0.0.1:8188",
      successCount: 1,
      requestedCount: 1,
    });

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-1", status: "RUNNING" },
        data: expect.objectContaining({
          provider: "local-comfyui",
          model: "sd_xl_base_1.0",
          endpoint: "http://127.0.0.1:8188",
        }),
      }),
    );
  });

  it("writes null endpoint for embedded/BYOK backends without a URL", async () => {
    await completeGenerationJob({
      jobId: "job-2",
      model: "sd15-emaonly",
      provider: "local-sd-cpp",
      successCount: 1,
      requestedCount: 1,
    });

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ endpoint: null }),
      }),
    );
  });
});

describe("completeGenerationJob failure paths", () => {
  it("rejects a late completion when the job is no longer RUNNING", async () => {
    // A crash-recovery sweep already flipped this job out of RUNNING.
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      completeGenerationJob({ jobId: "job-1", model: "m", provider: "p", successCount: 1, requestedCount: 1 }),
    ).rejects.toMatchObject({ code: "generation_job_not_running" });
  });

  it("rejects when the job row vanished after the update", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findUnique.mockResolvedValue(null);

    await expect(
      completeGenerationJob({ jobId: "job-1", model: "m", provider: "p", successCount: 1, requestedCount: 1 }),
    ).rejects.toMatchObject({ code: "generation_job_not_found" });
  });

  it("marks a zero-success completion FAILED with an error code", async () => {
    await completeGenerationJob({
      jobId: "job-1",
      model: "m",
      provider: "local-comfyui",
      successCount: 0,
      requestedCount: 2,
    });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", errorCode: "generation_failed" }),
      }),
    );
  });
});

describe("failRunningGenerationJob", () => {
  it("preserves an ApiError's code + message", async () => {
    await failRunningGenerationJob({
      jobId: "job-1",
      error: new ApiError({ status: 504, code: "provider_timeout", message: "timed out", retryable: true }),
      fallbackCode: "generation_error",
    });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-1", status: "RUNNING" },
        data: expect.objectContaining({ status: "FAILED", errorCode: "provider_timeout" }),
      }),
    );
  });

  it("falls back to the provided code for an unknown error and never throws", async () => {
    mocks.updateMany.mockRejectedValue(new Error("db unavailable"));
    // Must not throw even if the fail-write itself fails (best-effort recovery).
    await expect(
      failRunningGenerationJob({ jobId: "job-1", error: new Error("boom"), fallbackCode: "generation_error" }),
    ).resolves.toBeUndefined();
  });
});
