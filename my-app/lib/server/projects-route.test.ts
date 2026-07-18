import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  fetchProjects: vi.fn(),
  requireLocalWorkspaceOwner: vi.fn(),
  cloneProjectTemplate: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: { project: { create: mocks.create } },
}));
vi.mock("@/lib/server/queries", () => ({
  fetchProjects: mocks.fetchProjects,
}));
vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/project-templates", () => ({
  cloneProjectTemplate: mocks.cloneProjectTemplate,
}));
vi.mock("@/lib/i18n/server", () => ({
  resolveLocale: vi.fn().mockResolvedValue("en"),
}));

import { GET, POST } from "@/app/api/projects/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
});

describe("projects route", () => {
  it("passes the list cursor and limit into the bounded query", async () => {
    mocks.fetchProjects.mockResolvedValue({
      projects: [],
      hasMore: false,
      nextCursor: null,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/projects?cursor=project-24&limit=24"),
    );

    expect(response.status).toBe(200);
    expect(mocks.fetchProjects).toHaveBeenCalledWith("user-1", {
      cursor: "project-24",
      limit: 24,
    });
  });

  it("rejects the retired category field instead of preserving a legacy reader", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Legacy", category: "TOOLKIT" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_body" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates only the current STUDIO project shape", async () => {
    mocks.create.mockResolvedValue({
      id: "project-1",
      name: "Current",
      category: "STUDIO",
      createdAt: new Date("2026-07-13T00:00:00.000Z"),
      updatedAt: new Date("2026-07-13T00:00:00.000Z"),
    });

    const response = await POST(
      new NextRequest("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Current" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      data: { userId: "user-1", name: "Current", category: "STUDIO" },
    });
  });

  it("trims an explicit name before creating", async () => {
    mocks.create.mockResolvedValue({
      id: "project-2",
      name: "Launch",
      category: "STUDIO",
      createdAt: new Date("2026-07-13T00:00:00.000Z"),
      updatedAt: new Date("2026-07-13T00:00:00.000Z"),
    });

    const response = await POST(
      new NextRequest("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  Launch  " }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      data: { userId: "user-1", name: "Launch", category: "STUDIO" },
    });
  });

  it.each(["   ", "x".repeat(81)])("rejects an invalid explicit name", async (name) => {
    const response = await POST(
      new NextRequest("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_body" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("passes an explicit name through the template clone", async () => {
    mocks.cloneProjectTemplate.mockResolvedValue({
      id: "project-template-copy",
      name: "My campaign",
      category: "STUDIO",
      createdAt: new Date("2026-07-13T00:00:00.000Z"),
      updatedAt: new Date("2026-07-13T00:00:00.000Z"),
    });

    const response = await POST(
      new NextRequest("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: "template-1", name: "  My campaign  " }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.cloneProjectTemplate).toHaveBeenCalledWith({
      userId: "user-1",
      templateId: "template-1",
      name: "My campaign",
      t: expect.any(Function),
    });
  });
});
