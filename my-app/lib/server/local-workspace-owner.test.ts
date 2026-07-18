import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  ensureBuiltInProjectTemplates: vi.fn(),
}));

vi.mock("react", () => ({ cache: (operation: unknown) => operation }));
vi.mock("@/lib/desktop-runtime", () => ({ isDesktopRuntime: () => true }));
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
  mocks.ensureBuiltInProjectTemplates.mockResolvedValue(undefined);
  mocks.userCreate.mockResolvedValue({ id: "owner" });
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
