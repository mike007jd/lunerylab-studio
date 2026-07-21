import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  ensureBuiltInProjectTemplates: vi.fn(),
  isDesktopRuntime: vi.fn(),
}));

vi.mock("react", () => ({ cache: (operation: unknown) => operation }));
vi.mock("@/lib/desktop-runtime", () => ({
  isDesktopRuntime: () => mocks.isDesktopRuntime(),
}));
vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      create: mocks.userCreate,
    },
    userSettings: { upsert: vi.fn() },
  },
}));
vi.mock("@/lib/server/sample-projects", () => ({
  ensureBuiltInProjectTemplates: mocks.ensureBuiltInProjectTemplates,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.isDesktopRuntime.mockReturnValue(true);
  mocks.ensureBuiltInProjectTemplates.mockResolvedValue(undefined);
  mocks.userCreate.mockResolvedValue({ id: "owner" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("local workspace owner initialization", () => {
  it("creates a new owner and initializes templates without creating projects itself", async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    const { ensureLocalWorkspaceOwner, LOCAL_WORKSPACE_OWNER } = await import(
      "@/lib/server/local-workspace-owner"
    );

    await ensureLocalWorkspaceOwner();

    expect(mocks.userCreate).toHaveBeenCalledTimes(1);
    expect(mocks.ensureBuiltInProjectTemplates).toHaveBeenCalledWith(LOCAL_WORKSPACE_OWNER.id);
  });

  it("fills templates for an existing owner", async () => {
    mocks.userFindUnique.mockResolvedValue({ id: "owner" });
    const { ensureLocalWorkspaceOwner, LOCAL_WORKSPACE_OWNER } = await import(
      "@/lib/server/local-workspace-owner"
    );

    await ensureLocalWorkspaceOwner();

    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.ensureBuiltInProjectTemplates).toHaveBeenCalledWith(LOCAL_WORKSPACE_OWNER.id);
  });

  it("uses one single-flight for concurrent initialization", async () => {
    mocks.userFindUnique.mockResolvedValue({ id: "owner" });
    const { ensureLocalWorkspaceOwner } = await import("@/lib/server/local-workspace-owner");

    await Promise.all([
      ensureLocalWorkspaceOwner(),
      ensureLocalWorkspaceOwner(),
      ensureLocalWorkspaceOwner(),
    ]);

    expect(mocks.userFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.ensureBuiltInProjectTemplates).toHaveBeenCalledTimes(1);
  });
});

describe("requireLocalWorkspaceOwner desktop gate", () => {
  it("allows desktop runtime calls", async () => {
    mocks.isDesktopRuntime.mockReturnValue(true);
    mocks.userFindUnique.mockResolvedValue({ id: "owner" });
    const { requireLocalWorkspaceOwner, LOCAL_WORKSPACE_OWNER } = await import(
      "@/lib/server/local-workspace-owner"
    );

    await expect(requireLocalWorkspaceOwner()).resolves.toEqual(LOCAL_WORKSPACE_OWNER);
  });

  it("rejects non-desktop calls even in development", async () => {
    mocks.isDesktopRuntime.mockReturnValue(false);
    vi.stubEnv("NODE_ENV", "development");
    const { requireLocalWorkspaceOwner } = await import("@/lib/server/local-workspace-owner");

    const rejection = await requireLocalWorkspaceOwner().then(
      () => null,
      (error: Error & { status?: number; code?: string; retryable?: boolean }) => error,
    );

    expect(rejection).toMatchObject({
      name: "Error",
      status: 403,
      code: "workspace_api_disabled",
      message: "Workspace APIs are only available inside the desktop runtime.",
      retryable: false,
    });
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
  });
});
