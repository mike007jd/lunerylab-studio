import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/server/errors";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  restoreWorkspaceBackup: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/workspace-backup", () => ({
  restoreWorkspaceBackup: mocks.restoreWorkspaceBackup,
}));

import { POST } from "@/app/api/workspace/restore/route";

function restoreRequest(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/workspace/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
  mocks.restoreWorkspaceBackup.mockResolvedValue({ projects: 1, assets: 2 });
});

describe("POST /api/workspace/restore", () => {
  it("rejects non-desktop callers before accepting a backup", async () => {
    mocks.requireLocalWorkspaceOwner.mockRejectedValue(
      new ApiError({
        status: 403,
        code: "workspace_api_disabled",
        message: "Workspace APIs are only available inside the desktop runtime.",
        retryable: false,
      }),
    );

    const response = await restoreRequest({
      backup: { version: 1 },
      confirm: true,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "workspace_api_disabled" });
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });

  it("requires the desktop gate before applying a confirmed backup", async () => {
    const backup = { version: 1, exportedAt: "2026-07-21T00:00:00.000Z" };
    const response = await restoreRequest({ backup, confirm: true });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      restored: { projects: 1, assets: 2 },
    });
    expect(mocks.requireLocalWorkspaceOwner).toHaveBeenCalledTimes(1);
    expect(mocks.restoreWorkspaceBackup).toHaveBeenCalledWith(backup, { confirm: true });
  });

  it("rejects missing backup payloads after the desktop gate", async () => {
    const response = await restoreRequest({ confirm: true });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_request" });
    expect(mocks.requireLocalWorkspaceOwner).toHaveBeenCalledTimes(1);
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });
});
