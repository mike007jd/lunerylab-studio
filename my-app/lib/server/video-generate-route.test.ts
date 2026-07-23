import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  assertVideoGenerationPrismaSupport: vi.fn(),
  assertRequestContentLength: vi.fn(),
  parseFormData: vi.fn(),
  validateFiles: vi.fn(),
  ensureAppState: vi.fn(),
  resolveVideoModelEntry: vi.fn(),
  resolveVideoRuntime: vi.fn(),
  resolveOwnedProjectId: vi.fn(),
  createOrReplayGenerationJob: vi.fn(),
  persistUploadedImageReferenceFiles: vi.fn(),
  loadRequiredImageReferenceFile: vi.fn(),
  runVideoJob: vi.fn(),
  failRunningGenerationJob: vi.fn(),
  createRouteTelemetry: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/prisma", () => ({
  assertVideoGenerationPrismaSupport: mocks.assertVideoGenerationPrismaSupport,
}));
vi.mock("@/lib/server/file-validation", () => ({
  assertRequestContentLength: mocks.assertRequestContentLength,
  validateFiles: mocks.validateFiles,
}));
vi.mock("@/lib/server/http-validation", () => ({
  parseFormData: mocks.parseFormData,
}));
vi.mock("@/lib/server/app-state", () => ({
  ensureAppState: mocks.ensureAppState,
}));
vi.mock("@/lib/server/model-catalog", () => ({
  resolveVideoModelEntry: mocks.resolveVideoModelEntry,
}));
vi.mock("@/lib/server/video-runtime", () => ({
  resolveVideoRuntime: mocks.resolveVideoRuntime,
}));
vi.mock("@/lib/server/generate-request", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/generate-request")>(
    "@/lib/server/generate-request",
  );
  return {
    ...actual,
    resolveOwnedProjectId: mocks.resolveOwnedProjectId,
  };
});
vi.mock("@/lib/server/idempotency", () => ({
  createOrReplayGenerationJob: mocks.createOrReplayGenerationJob,
}));
vi.mock("@/lib/server/reference-assets", () => ({
  persistUploadedImageReferenceFiles: mocks.persistUploadedImageReferenceFiles,
  loadRequiredImageReferenceFile: mocks.loadRequiredImageReferenceFile,
}));
vi.mock("@/lib/server/video-job", () => ({
  runVideoJob: mocks.runVideoJob,
}));
vi.mock("@/lib/server/generation-job", () => ({
  failRunningGenerationJob: mocks.failRunningGenerationJob,
}));
vi.mock("@/lib/server/route-telemetry", () => ({
  createRouteTelemetry: mocks.createRouteTelemetry,
}));
vi.mock("@/lib/server/env", () => ({
  getMaxUploadBytesPerFile: () => 8 * 1024 * 1024,
}));

import { POST } from "@/app/api/generate/video/route";

const videoModelEntry = {
  id: "byok:fal:bytedance/seedance",
  providerModelId: "bytedance/seedance",
  brand: "Fal",
  brandZh: "Fal",
  label: "Seedance",
  labelZh: "Seedance",
  tier: "standard",
  durationMode: "range",
  durationRange: [4, 12],
  supportsImageInput: true,
  requiresImageInput: false,
  source: "byok",
};

function formRequest(fields: Record<string, string>): Request {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return new Request("http://localhost/api/generate/video", {
    method: "POST",
    body: formData,
  });
}

describe("POST /api/generate/video", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
    mocks.assertVideoGenerationPrismaSupport.mockReturnValue(undefined);
    mocks.parseFormData.mockImplementation(async (request: Request) => request.formData());
    mocks.validateFiles.mockResolvedValue(undefined);
    mocks.ensureAppState.mockResolvedValue(undefined);
    mocks.resolveOwnedProjectId.mockResolvedValue(null);
    mocks.createRouteTelemetry.mockReturnValue({
      start: vi.fn(),
      done: vi.fn(),
      failed: vi.fn(),
    });
    mocks.resolveVideoModelEntry.mockResolvedValue(videoModelEntry);
    mocks.resolveVideoRuntime.mockResolvedValue({
      backend: "byok",
      providerId: "fal",
      modelId: "bytedance/seedance",
      warnings: [],
    });
    mocks.createOrReplayGenerationJob.mockResolvedValue({
      kind: "created",
      job: { id: "job-1", status: "RUNNING", videoDuration: 6, projectId: null },
    });
    mocks.runVideoJob.mockResolvedValue(undefined);
  });

  it("rejects unknown model ids as invalid_model", async () => {
    mocks.resolveVideoModelEntry.mockResolvedValue(undefined);

    const response = await POST(
      formRequest({ prompt: "clip", modelId: "cloud:retired", duration: "6" }) as never,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("invalid_model");
    expect(mocks.runVideoJob).not.toHaveBeenCalled();
  });

  it("returns RUNNING immediately and observes the started job promise", async () => {
    let resolveJob!: () => void;
    const jobPromise = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });
    mocks.runVideoJob.mockReturnValue(jobPromise);
    const response = await POST(
      formRequest({
        prompt: "a clip",
        modelId: "byok:fal:bytedance/seedance",
        duration: "6",
      }) as never,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      jobId: "job-1",
      status: "RUNNING",
      duration: 6,
    });
    expect(mocks.runVideoJob).toHaveBeenCalledOnce();
    resolveJob();
    await jobPromise;
  });

  it("observes and logs a background job rejection after returning RUNNING", async () => {
    let rejectJob!: (error: Error) => void;
    const jobPromise = new Promise<void>((_resolve, reject) => {
      rejectJob = reject;
    });
    mocks.runVideoJob.mockReturnValue(jobPromise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await POST(
        formRequest({
          prompt: "a clip",
          modelId: "byok:fal:bytedance/seedance",
          duration: "6",
        }) as never,
      );

      expect(response.status).toBe(200);
      rejectJob(new Error("background boom"));
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "[video_job_background_failed]",
          expect.objectContaining({ message: "background boom" }),
        );
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});
