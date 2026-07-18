import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  ensureLocalWorkspaceOwner: vi.fn(),
  fetchBootstrapData: vi.fn(),
  fetchSidebarProjects: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/desktop-runtime", () => ({ isDesktopRuntime: () => true }));
vi.mock("@/lib/public-site", () => ({ PUBLIC_SITE_DOWNLOAD_URL: "https://example.com/download" }));
vi.mock("@/lib/server/local-workspace-owner", () => ({
  LOCAL_WORKSPACE_OWNER: { id: "owner-1", email: "local@example.com", name: "Local", avatarUrl: null },
  ensureLocalWorkspaceOwner: mocks.ensureLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/queries", () => ({
  fetchBootstrapData: mocks.fetchBootstrapData,
  fetchSidebarProjects: mocks.fetchSidebarProjects,
}));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/lib/client/bootstrap-snapshot-provider", () => ({ BootstrapSnapshotProvider: () => null }));
vi.mock("@/lib/client/active-project-provider", () => ({ ActiveProjectProvider: () => null }));
vi.mock("@/hooks/use-creative-capability-readiness", () => ({
  CreativeCapabilityReadinessProvider: () => null,
}));

import ConsoleLayout from "@/app/(console)/layout";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchBootstrapData.mockResolvedValue({
    app: {},
    features: {},
    providers: [],
    providerConnections: [],
  });
  mocks.fetchSidebarProjects.mockResolvedValue([]);
  mocks.cookies.mockResolvedValue({ get: () => undefined });
});

describe("console initialization ordering", () => {
  it("finishes owner and template initialization before reading shell state", async () => {
    let finishInitialization: (() => void) | undefined;
    mocks.ensureLocalWorkspaceOwner.mockReturnValue(new Promise<void>((resolve) => {
      finishInitialization = resolve;
    }));

    const layout = ConsoleLayout({ children: null });
    await Promise.resolve();

    expect(mocks.fetchBootstrapData).not.toHaveBeenCalled();
    expect(mocks.fetchSidebarProjects).not.toHaveBeenCalled();
    expect(mocks.cookies).not.toHaveBeenCalled();

    finishInitialization?.();
    await layout;

    expect(mocks.fetchBootstrapData).toHaveBeenCalledOnce();
    expect(mocks.fetchSidebarProjects).toHaveBeenCalledOnce();
    expect(mocks.cookies).toHaveBeenCalledOnce();
  });
});
