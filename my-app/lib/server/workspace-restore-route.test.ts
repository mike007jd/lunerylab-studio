import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/server/errors";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  restoreWorkspaceBackup: vi.fn(),
  freeDiskBytes: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/workspace-backup", () => ({
  BACKUP_FORMAT: "lunery-workspace-backup",
  BACKUP_VERSION: 2,
  CURRENT_SCHEMA_VERSION: "20260601000000_initial.reference-set-default-v2",
  restoreWorkspaceBackup: mocks.restoreWorkspaceBackup,
}));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    statfs: async () => ({
      bavail: Math.floor((mocks.freeDiskBytes() ?? 10 * 1024 * 1024 * 1024) / 4096),
      bsize: 4096,
    }),
  };
});

import { POST } from "@/app/api/workspace/restore/route";
import {
  assertRestorePayloadLimits,
  RESTORE_LIMITS,
} from "@/lib/server/workspace-restore-limits";

function restoreRequest(
  body: unknown,
  {
    contentLength,
    omitContentLength = false,
  }: { contentLength?: number; omitContentLength?: boolean } = {},
) {
  const payload = JSON.stringify(body);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (!omitContentLength) {
    headers.set("Content-Length", String(contentLength ?? Buffer.byteLength(payload)));
  }
  return POST(
    new NextRequest("http://localhost/api/workspace/restore", {
      method: "POST",
      headers,
      body: payload,
    }),
  );
}

function minimalBackup() {
  const emptyData = Object.fromEntries(
    [
      "appState",
      "user",
      "userSettings",
      "project",
      "generationJob",
      "asset",
      "canvasSession",
      "canvasSnapshot",
      "agentTask",
      "canvasLayer",
      "agentMessage",
      "agentTaskStep",
      "referenceSet",
      "referenceSetAsset",
    ].map((key) => [key, []]),
  );
  return {
    manifest: {
      format: "lunery-workspace-backup",
      version: 2,
      appVersion: "0.2.1",
      schemaVersion: "20260601000000_initial.reference-set-default-v2",
      createdAt: "2026-07-21T00:00:00.000Z",
      counts: Object.fromEntries(Object.keys(emptyData).map((key) => [key, 0])),
      dataSha256: "x".repeat(64),
      media: [],
      config: [],
      excluded: [],
    },
    data: emptyData,
    media: [],
    config: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
  mocks.restoreWorkspaceBackup.mockResolvedValue({ projects: 1, assets: 2 });
  mocks.freeDiskBytes.mockReturnValue(10 * 1024 * 1024 * 1024);
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
      backup: minimalBackup(),
      confirm: true,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "workspace_api_disabled" });
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });

  it("requires the desktop gate before applying a confirmed backup", async () => {
    const backup = minimalBackup();
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

  it("returns stable 413 when Content-Length is missing", async () => {
    const response = await restoreRequest(
      { backup: minimalBackup(), confirm: true },
      { omitContentLength: true },
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "request_too_large" });
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });

  it("returns stable 413 when encoded Content-Length exceeds the limit before staging", async () => {
    const response = await restoreRequest(
      { backup: minimalBackup(), confirm: true },
      { contentLength: RESTORE_LIMITS.maxEncodedBytes + 1 },
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "request_too_large" });
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });

  it("keeps the current JSON envelope below a heap-safe wire ceiling", () => {
    expect(RESTORE_LIMITS.maxEncodedBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(RESTORE_LIMITS.maxAggregateDecodedBytes).toBeLessThan(
      RESTORE_LIMITS.maxEncodedBytes,
    );
    expect(RESTORE_LIMITS.maxPerFileDecodedBytes).toBeLessThanOrEqual(
      RESTORE_LIMITS.maxAggregateDecodedBytes,
    );
  });

  it("rejects Content-Length mismatch instead of accepting an ambiguous body", async () => {
    const body = { backup: minimalBackup(), confirm: true };
    const actualLength = Buffer.byteLength(JSON.stringify(body));
    const response = await restoreRequest(body, {
      contentLength: actualLength + 1,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "request_too_large" });
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });

  it("returns stable 413 when a decoded media payload exceeds the per-file limit", () => {
    const limits = { ...RESTORE_LIMITS, maxPerFileDecodedBytes: 16 };
    // 24 base64 chars ≈ 18 decoded bytes > 16.
    const oversized = "A".repeat(24);
    expect(() =>
      assertRestorePayloadLimits(
        {
          ...minimalBackup(),
          media: [{ path: "generated/huge.mp4", base64: oversized }],
        } as never,
        limits,
      ),
    ).toThrow(ApiError);
    try {
      assertRestorePayloadLimits(
        {
          ...minimalBackup(),
          media: [{ path: "generated/huge.mp4", base64: oversized }],
        } as never,
        limits,
      );
    } catch (error) {
      expect((error as ApiError).status).toBe(413);
      expect((error as ApiError).code).toBe("request_too_large");
    }
  });

  it("sizes disk headroom from the actual payload instead of the theoretical file maximum", async () => {
    mocks.freeDiskBytes.mockReturnValue(1024 * 1024);

    const response = await restoreRequest({ backup: minimalBackup(), confirm: true });

    expect(response.status).toBe(200);
    expect(mocks.restoreWorkspaceBackup).toHaveBeenCalledTimes(1);
  });

  it("returns stable 413 when actual staged payload lacks rollback headroom", async () => {
    mocks.freeDiskBytes.mockReturnValue(150);
    const backup = {
      ...minimalBackup(),
      media: [{ path: "generated/video.mp4", base64: Buffer.alloc(100).toString("base64") }],
    };

    const response = await restoreRequest({ backup, confirm: true });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "request_too_large" });
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });
});
