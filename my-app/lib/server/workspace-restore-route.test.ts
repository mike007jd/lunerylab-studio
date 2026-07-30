import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/server/errors";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  restoreWorkspaceBackup: vi.fn(),
  freeDiskBytes: vi.fn(),
  pgliteDiskBytes: vi.fn(),
  readdirError: null as NodeJS.ErrnoException | null,
  statError: null as NodeJS.ErrnoException | null,
  rootStatError: null as NodeJS.ErrnoException | null,
  statfsError: null as NodeJS.ErrnoException | null,
  childStatFailuresRemaining: 0,
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/workspace-backup", () => ({
  BACKUP_FORMAT: "lunery-workspace-backup",
  BACKUP_VERSION: 3,
  CURRENT_SCHEMA_VERSION: "20260601000000_initial.workspace-restore-v3",
  restoreWorkspaceBackup: mocks.restoreWorkspaceBackup,
}));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readdir: async () => {
      if (mocks.readdirError) throw mocks.readdirError;
      const bytes = mocks.pgliteDiskBytes() ?? 0;
      if (bytes <= 0) return [];
      return [{
        name: "base.dat",
        isDirectory: () => false,
        isFile: () => true,
      }];
    },
    stat: async (target: string) => {
      if (!target.endsWith("base.dat") && mocks.rootStatError) {
        throw mocks.rootStatError;
      }
      if (mocks.statError) throw mocks.statError;
      if (mocks.childStatFailuresRemaining > 0) {
        mocks.childStatFailuresRemaining -= 1;
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return { size: mocks.pgliteDiskBytes() ?? 0 };
    },
    statfs: async () => {
      if (mocks.statfsError) throw mocks.statfsError;
      return {
        bavail: Math.floor((mocks.freeDiskBytes() ?? 10 * 1024 * 1024 * 1024) / 4096),
        bsize: 4096,
      };
    },
  };
});

import { POST } from "@/app/api/workspace/restore/route";
import {
  assertRestoreDiskHeadroom,
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
      version: 3,
      appVersion: "0.2.1",
      schemaVersion: "20260601000000_initial.workspace-restore-v3",
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
  mocks.pgliteDiskBytes.mockReturnValue(0);
  mocks.readdirError = null;
  mocks.statError = null;
  mocks.rootStatError = null;
  mocks.statfsError = null;
  mocks.childStatFailuresRemaining = 0;
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

  it("accounts for database row data in disk headroom and rejects DB-heavy restores", async () => {
    // Media/config empty; serialized agentMessage rows alone need ~2x headroom.
    mocks.freeDiskBytes.mockReturnValue(8 * 1024);
    const backup = {
      ...minimalBackup(),
      data: {
        ...minimalBackup().data,
        agentMessage: Array.from({ length: 40 }, (_, index) => ({
          id: `msg-${index}`,
          content: "x".repeat(120),
        })),
      },
    };

    const response = await restoreRequest({ backup, confirm: true });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "request_too_large" });
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });

  it("uses encoded bytes for DB headroom without reserializing parsed rows", async () => {
    const row = Object.defineProperty(
      { id: "large-message", content: "x".repeat(1024) },
      "toJSON",
      {
        get() {
          throw new Error("restore headroom must not stringify rows");
        },
      },
    );
    const backup = {
      ...minimalBackup(),
      data: {
        ...minimalBackup().data,
        agentMessage: [row],
      },
    };

    await expect(
      assertRestoreDiskHeadroom(backup as never, 2 * 1024),
    ).resolves.toBeUndefined();
  });

  it("accounts for the current PGlite database retained by the restore transaction", async () => {
    mocks.freeDiskBytes.mockReturnValue(8 * 1024);
    mocks.pgliteDiskBytes.mockReturnValue(5 * 1024);

    const response = await restoreRequest({ backup: minimalBackup(), confirm: true });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "request_too_large" });
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });

  it("does not impose the theoretical per-file maximum on tiny database-only backups", async () => {
    mocks.freeDiskBytes.mockReturnValue(64 * 1024);
    mocks.pgliteDiskBytes.mockReturnValue(8 * 1024);
    const backup = {
      ...minimalBackup(),
      data: {
        ...minimalBackup().data,
        project: [{ id: "p1", name: "Tiny" }],
      },
    };

    const response = await restoreRequest({ backup, confirm: true });

    expect(response.status).toBe(200);
    expect(mocks.restoreWorkspaceBackup).toHaveBeenCalledTimes(1);
  });

  it.each(["EACCES", "EIO"] as const)(
    "fails closed when statfs returns %s",
    async (code) => {
      const error = new Error(code) as NodeJS.ErrnoException;
      error.code = code;
      mocks.statfsError = error;

      const response = await restoreRequest({ backup: minimalBackup(), confirm: true });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "restore_capacity_unavailable",
      });
      expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
    },
  );

  it("fails closed when PGlite root readdir returns EACCES", async () => {
    const error = new Error("EACCES") as NodeJS.ErrnoException;
    error.code = "EACCES";
    mocks.readdirError = error;

    const response = await restoreRequest({ backup: minimalBackup(), confirm: true });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "restore_capacity_unavailable",
    });
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });

  it("fails closed when a PGlite child stat returns EIO", async () => {
    mocks.pgliteDiskBytes.mockReturnValue(1024);
    const error = new Error("EIO") as NodeJS.ErrnoException;
    error.code = "EIO";
    mocks.statError = error;

    const response = await restoreRequest({ backup: minimalBackup(), confirm: true });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "restore_capacity_unavailable",
    });
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });

  it("treats a confirmed absent PGlite root as zero current DB size", async () => {
    const error = new Error("ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    mocks.readdirError = error;
    mocks.rootStatError = error;
    mocks.freeDiskBytes.mockReturnValue(64 * 1024);

    const response = await restoreRequest({ backup: minimalBackup(), confirm: true });

    expect(response.status).toBe(200);
    expect(mocks.restoreWorkspaceBackup).toHaveBeenCalledTimes(1);
  });

  it("fails closed when one root readdir ENOENT is not confirmed by stat", async () => {
    const error = new Error("ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    mocks.readdirError = error;
    mocks.pgliteDiskBytes.mockReturnValue(8 * 1024);

    const response = await restoreRequest({ backup: minimalBackup(), confirm: true });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "restore_capacity_unavailable",
    });
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });

  it("retries one transient child ENOENT then uses the measured size", async () => {
    mocks.pgliteDiskBytes.mockReturnValue(5 * 1024);
    mocks.freeDiskBytes.mockReturnValue(8 * 1024);
    mocks.childStatFailuresRemaining = 1;

    const response = await restoreRequest({ backup: minimalBackup(), confirm: true });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "request_too_large" });
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });

  it("fails closed when child ENOENT races exceed the retry budget", async () => {
    mocks.pgliteDiskBytes.mockReturnValue(1024);
    mocks.childStatFailuresRemaining = 10;

    const response = await restoreRequest({ backup: minimalBackup(), confirm: true });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "restore_capacity_unavailable",
    });
    expect(mocks.restoreWorkspaceBackup).not.toHaveBeenCalled();
  });
});
