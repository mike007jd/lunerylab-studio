import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  jobFindMany: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/prisma", () => ({
  prisma: { generationJob: { findMany: mocks.jobFindMany } },
}));

import { GET } from "@/app/api/jobs/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
  mocks.jobFindMany.mockResolvedValue([]);
});

describe("generation history", () => {
  it("never exposes template bootstrap jobs as user history", async () => {
    const response = await GET(new NextRequest("http://localhost/api/jobs?projectId=project-1"));

    expect(response.status).toBe(200);
    expect(mocks.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", origin: "USER", projectId: "project-1" },
      }),
    );
  });
});
