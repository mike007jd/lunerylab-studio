import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  assertVideoGenerationPrismaSupport: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  toAssetDTO: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/prisma", () => ({
  assertVideoGenerationPrismaSupport: mocks.assertVideoGenerationPrismaSupport,
  prisma: {
    generationJob: {
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
    },
  },
}));
vi.mock("@/lib/server/dto", () => ({
  toAssetDTO: mocks.toAssetDTO,
}));

import { GET } from "@/app/api/generate/video/[jobId]/status/route";
import { VIDEO_JOB_TIMEOUT_MS } from "@/lib/constants/video-generation";

describe("GET /api/generate/video/[jobId]/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
    mocks.assertVideoGenerationPrismaSupport.mockReturnValue(undefined);
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it("atomically marks a stale RUNNING job failed before reporting the timeout", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "job-stale",
      status: "RUNNING",
      createdAt: new Date(Date.now() - VIDEO_JOB_TIMEOUT_MS - 1),
      assets: [],
      errorMessage: null,
    });

    const response = await GET(
      new Request("http://localhost/api/generate/video/job-stale/status") as never,
      { params: Promise.resolve({ jobId: "job-stale" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "FAILED",
      error: "Video generation did not finish in time. Please start a new job.",
    });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "job-stale", userId: "user-1", status: "RUNNING" },
      data: {
        status: "FAILED",
        errorCode: "video_job_stale",
        errorMessage: "Video generation did not finish in time. Please start a new job.",
        completedAt: expect.any(Date),
      },
    });
  });
});
