import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  reenterWorkspaceInitialization: null as null | (() => Promise<void>),
  resolveLocale: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  userSettingsFindUnique: vi.fn(),
  projectFindMany: vi.fn(),
}));

// This dependency is intentionally hostile: if template initialization ever
// calls the request-level locale resolver again, it re-enters the same pending
// workspace promise and the bounded assertion below times out.
vi.mock("@/lib/i18n/server", () => ({
  resolveLocale: mocks.resolveLocale,
}));

vi.mock("@/lib/sample-data", () => ({
  SAMPLE_PROJECTS: [],
  SAMPLE_SOURCE_MIME_TYPE: "image/webp",
}));

vi.mock("@/lib/server/storage", () => ({
  deleteStoredFile: vi.fn(),
  restoreStoredFile: vi.fn(),
  writeGeneratedImage: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      create: mocks.userCreate,
    },
    userSettings: {
      findUnique: mocks.userSettingsFindUnique,
    },
    project: {
      findMany: mocks.projectFindMany,
    },
  },
}));

import { ensureLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";

describe("local workspace first boot", () => {
  it("completes without re-entering its pending initialization promise", async () => {
    mocks.reenterWorkspaceInitialization = ensureLocalWorkspaceOwner;
    mocks.resolveLocale.mockImplementation(async () => {
      await mocks.reenterWorkspaceInitialization?.();
      return "en";
    });
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: "00000000-0000-0000-0000-000000000000" });
    mocks.userSettingsFindUnique.mockResolvedValue({ defaultLocale: "en" });
    mocks.projectFindMany.mockResolvedValue([]);

    const outcome = await Promise.race([
      ensureLocalWorkspaceOwner().then(() => "completed"),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 1_000);
      }),
    ]);

    expect(outcome).toBe("completed");
    expect(mocks.resolveLocale).not.toHaveBeenCalled();
    expect(mocks.userSettingsFindUnique).toHaveBeenCalledWith({
      where: { userId: "00000000-0000-0000-0000-000000000000" },
      select: { defaultLocale: true },
    });
  });
});
