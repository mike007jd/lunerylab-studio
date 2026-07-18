import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  fetchProjectActivity: vi.fn(),
  requireLocalWorkspaceOwner: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: { project: { update: mocks.updateProject } },
}));
vi.mock("@/lib/server/queries", () => ({
  fetchProjectActivity: mocks.fetchProjectActivity,
}));
vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));

import { GET, PATCH } from "@/app/api/projects/[id]/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
  mocks.fetchProjectActivity.mockResolvedValue({
    project: {
      id: "project-1",
      name: "Project",
      category: "STUDIO",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    },
    jobs: { items: [], hasMore: false, nextCursor: null },
    canvasSessions: null,
  });

});

describe("project detail route", () => {
  it("forwards an independent jobs cursor without loading the canvas page", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/projects/project-1?section=jobs&jobsCursor=job-6",
      ),
      { params: Promise.resolve({ id: "project-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.fetchProjectActivity).toHaveBeenCalledWith("user-1", "project-1", {
      section: "jobs",
      jobsCursor: "job-6",
      canvasSessionsCursor: undefined,
    });
  });

  it("trims and returns the authoritative renamed project", async () => {
    mocks.updateProject.mockResolvedValue({
      id: "project-1",
      name: "Launch",
      updatedAt: new Date("2026-07-17T00:00:00.000Z"),
    });

    const response = await PATCH(
      new NextRequest("http://localhost/api/projects/project-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  Launch  " }),
      }),
      { params: Promise.resolve({ id: "project-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.updateProject).toHaveBeenCalledWith({
      where: { id: "project-1", userId: "user-1", isTemplate: false },
      data: { name: "Launch" },
      select: { id: true, name: true, updatedAt: true },
    });
    await expect(response.json()).resolves.toEqual({
      project: {
        id: "project-1",
        name: "Launch",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
    });
  });

  it.each(["", "x".repeat(81)])("rejects an invalid project rename", async (name) => {
    const response = await PATCH(
      new NextRequest("http://localhost/api/projects/project-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
      { params: Promise.resolve({ id: "project-1" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_body" });
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });
});
