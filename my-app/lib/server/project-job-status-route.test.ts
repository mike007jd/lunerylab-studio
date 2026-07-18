import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  requireLocalWorkspaceOwner: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: { project: { findUnique: mocks.findUnique } },
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));

import { GET } from "@/app/api/projects/[id]/jobs/status/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
});

describe("project job status route", () => {
  it("returns only the lightweight job projection used by polling", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "project-1",
      jobs: [
        {
          id: "job-1",
          status: "RUNNING",
          prompt: "Product hero",
          requestedCount: 2,
          successCount: 1,
          createdAt: new Date("2026-07-13T00:00:00.000Z"),
        },
      ],
    });

    const response = await GET(
      new NextRequest("http://localhost/api/projects/project-1/jobs/status"),
      { params: Promise.resolve({ id: "project-1" }) },
    );

    await expect(response.json()).resolves.toEqual({
      jobs: [
        {
          id: "job-1",
          status: "RUNNING",
          prompt: "Product hero",
          requestedCount: 2,
          successCount: 1,
          createdAt: "2026-07-13T00:00:00.000Z",
        },
      ],
    });
    const query = mocks.findUnique.mock.calls[0]?.[0];
    expect(query).toMatchObject({
      where: { id: "project-1", userId: "user-1" },
      select: { id: true, jobs: expect.any(Object) },
    });
    expect(query.select).not.toHaveProperty("assets");
    expect(query.select).not.toHaveProperty("canvasSessions");
  });
});
