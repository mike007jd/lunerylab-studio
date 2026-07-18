import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  requireLocalWorkspaceOwner: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: { canvasSession: { findUnique: mocks.findUnique } },
}));
vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));

import { GET } from "@/app/api/canvas/sessions/[id]/revision/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
});

describe("canvas session revision route", () => {
  it("returns only the owned session revision", async () => {
    mocks.findUnique.mockResolvedValue({
      updatedAt: new Date("2026-07-13T00:00:00.000Z"),
      _count: { layers: 2 },
      layers: [{ updatedAt: new Date("2026-07-13T00:00:02.000Z") }],
    });

    const response = await GET(
      new NextRequest("http://localhost/api/canvas/sessions/session-1/revision"),
      { params: Promise.resolve({ id: "session-1" }) },
    );

    await expect(response.json()).resolves.toEqual({
      revision:
        "2026-07-13T00:00:00.000Z|2|2026-07-13T00:00:02.000Z",
    });
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: "session-1", userId: "user-1" },
      select: {
        updatedAt: true,
        _count: { select: { layers: true } },
        layers: {
          select: { updatedAt: true },
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
      },
    });
  });

  it("changes revision for pure layer updates and deletes", async () => {
    const parentUpdatedAt = new Date("2026-07-13T00:00:00.000Z");
    mocks.findUnique
      .mockResolvedValueOnce({
        updatedAt: parentUpdatedAt,
        _count: { layers: 2 },
        layers: [{ updatedAt: new Date("2026-07-13T00:00:01.000Z") }],
      })
      .mockResolvedValueOnce({
        updatedAt: parentUpdatedAt,
        _count: { layers: 2 },
        layers: [{ updatedAt: new Date("2026-07-13T00:00:02.000Z") }],
      })
      .mockResolvedValueOnce({
        updatedAt: parentUpdatedAt,
        _count: { layers: 1 },
        layers: [{ updatedAt: new Date("2026-07-13T00:00:02.000Z") }],
      });

    const revisions: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await GET(
        new NextRequest("http://localhost/api/canvas/sessions/session-1/revision"),
        { params: Promise.resolve({ id: "session-1" }) },
      );
      const body = (await response.json()) as { revision: string };
      revisions.push(body.revision);
    }

    expect(new Set(revisions).size).toBe(3);
  });

  it("returns 404 for an unknown or unowned session", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await GET(
      new NextRequest("http://localhost/api/canvas/sessions/missing/revision"),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(response.status).toBe(404);
  });
});
