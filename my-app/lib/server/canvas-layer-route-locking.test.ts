import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  requireWritableCanvasSession: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
  findFirst: vi.fn(),
  findSession: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));

vi.mock("@/lib/server/canvas-session-access", () => ({
  requireWritableCanvasSession: mocks.requireWritableCanvasSession,
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    canvasLayer: {
      deleteMany: mocks.deleteMany,
      updateMany: mocks.updateMany,
      findFirst: mocks.findFirst,
    },
    canvasSession: {
      findUnique: mocks.findSession,
    },
  },
}));

import {
  DELETE,
  PATCH,
} from "@/app/api/canvas/sessions/[id]/layers/[layerId]/route";

const params = {
  params: Promise.resolve({ id: "session-1", layerId: "layer-1" }),
};

function patchRequest(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/canvas/sessions/session-1/layers/layer-1",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("canvas layer route locking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
    mocks.requireWritableCanvasSession.mockResolvedValue({ id: "session-1" });
  });

  it("atomically refuses to delete a layer that is currently locked", async () => {
    mocks.deleteMany.mockResolvedValue({ count: 0 });
    mocks.findFirst.mockResolvedValue({ locked: true });

    const response = await DELETE(
      new NextRequest(
        "http://localhost/api/canvas/sessions/session-1/layers/layer-1",
        { method: "DELETE" },
      ),
      params,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "canvas_layer_locked",
    });
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "layer-1", locked: false }),
    });
  });

  it("keeps a missed delete as conflict when the row concurrently unlocks", async () => {
    mocks.deleteMany.mockResolvedValue({ count: 0 });
    mocks.findFirst.mockResolvedValue({ locked: false });

    const response = await DELETE(
      new NextRequest(
        "http://localhost/api/canvas/sessions/session-1/layers/layer-1",
        { method: "DELETE" },
      ),
      params,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "canvas_layer_locked",
    });
    expect(mocks.findSession).not.toHaveBeenCalled();
  });

  it("requires the row to remain unlocked for geometry changes", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.findFirst.mockResolvedValue({ locked: true });

    const response = await PATCH(patchRequest({ x: 42 }), params);

    expect(response.status).toBe(409);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "layer-1", locked: false }),
      data: { x: 42 },
    });
  });

  it("preserves an explicit unlock operation for a locked layer", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findFirst.mockResolvedValue({
      id: "layer-1",
      sessionId: "session-1",
      assetId: "asset-1",
      asset: { id: "asset-1", kind: "GENERATED" },
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 1,
      locked: false,
      hidden: false,
      createdAt: new Date("2026-07-29T00:00:00.000Z"),
      updatedAt: new Date("2026-07-29T00:00:01.000Z"),
    });

    const response = await PATCH(patchRequest({ locked: false }), params);

    expect(response.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: expect.not.objectContaining({ locked: false }),
      data: { locked: false },
    });
    await expect(response.json()).resolves.toMatchObject({
      layer: { id: "layer-1", locked: false },
    });
  });
});
