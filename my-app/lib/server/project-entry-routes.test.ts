import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  ensureLocalWorkspaceOwner: vi.fn(),
  fetchProjectOptions: vi.fn(),
  fetchProjects: vi.fn(),
  fetchProjectTemplates: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  LOCAL_WORKSPACE_OWNER: { id: "owner-1" },
  ensureLocalWorkspaceOwner: mocks.ensureLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/queries", () => ({
  fetchProjectOptions: mocks.fetchProjectOptions,
  fetchProjects: mocks.fetchProjects,
}));
vi.mock("@/lib/server/project-templates", () => ({
  fetchProjectTemplates: mocks.fetchProjectTemplates,
}));
vi.mock("@/components/studio/studio-page", () => ({ StudioPage: () => null }));
vi.mock("@/components/library/projects-index", () => ({ ProjectsIndex: () => null }));
vi.mock("@/components/motion/motion-primitives", () => ({
  PageReveal: ({ children }: { children: unknown }) => children,
}));

import ProjectsRoute from "@/app/(console)/projects/page";
import StudioRoute from "@/app/(console)/studio/page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureLocalWorkspaceOwner.mockResolvedValue(undefined);
  mocks.fetchProjectOptions.mockResolvedValue([]);
  mocks.fetchProjects.mockResolvedValue({ projects: [], hasMore: false, nextCursor: null });
  mocks.fetchProjectTemplates.mockResolvedValue([]);
});

describe("empty first-launch project routes", () => {
  it("renders Studio from one personal-project query without implicit creation", async () => {
    await StudioRoute();

    expect(mocks.fetchProjectOptions).toHaveBeenCalledOnce();
  });

  it("renders Projects with empty personal projects and initialized templates", async () => {
    await ProjectsRoute();

    expect(mocks.fetchProjects).toHaveBeenCalledOnce();
    expect(mocks.fetchProjectTemplates).toHaveBeenCalledOnce();
  });
});
