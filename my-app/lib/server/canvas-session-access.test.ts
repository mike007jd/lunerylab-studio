import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: { canvasSession: { findUnique: mocks.findUnique } },
}));

import { requireWritableCanvasSession } from "@/lib/server/canvas-session-access";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireWritableCanvasSession", () => {
  it("allows a user project session", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "session-1",
      projectId: "project-1",
      project: { isTemplate: false },
    });

    await expect(requireWritableCanvasSession("session-1", "user-1")).resolves.toMatchObject({
      id: "session-1",
    });
  });

  it("keeps an original template session read-only", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "template-session",
      projectId: "template-project",
      project: { isTemplate: true },
    });

    await expect(
      requireWritableCanvasSession("template-session", "user-1"),
    ).rejects.toMatchObject({
      status: 409,
      code: "template_project_read_only",
    });
  });

  it("does not expose another user's session", async () => {
    mocks.findUnique.mockResolvedValue(null);

    await expect(
      requireWritableCanvasSession("other-session", "user-1"),
    ).rejects.toMatchObject({
      status: 404,
      code: "canvas_session_not_found",
    });
  });
});
