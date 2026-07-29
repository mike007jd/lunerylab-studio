import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureLocalWorkspaceOwner: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  LOCAL_WORKSPACE_OWNER: { id: "user-1" },
  ensureLocalWorkspaceOwner: mocks.ensureLocalWorkspaceOwner,
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    project: {
      findUnique: mocks.findUnique,
    },
  },
}));

vi.mock("@/lib/server/queries", () => ({
  fetchProjectWorkspace: vi.fn(),
}));

vi.mock("@/components/library/project-workspace", () => ({
  ProjectWorkspace: () => null,
}));

vi.mock("@/components/motion/motion-primitives", () => ({
  PageReveal: ({ children }: { children: unknown }) => children,
}));

import { generateMetadata } from "@/app/(console)/projects/[id]/page";

describe("project route metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureLocalWorkspaceOwner.mockResolvedValue(undefined);
  });

  it("uses the project-specific name for metadata title", async () => {
    mocks.findUnique.mockResolvedValue({ name: "Launch Storyboard" });

    await expect(
      generateMetadata({ params: Promise.resolve({ id: "project-1" }) }),
    ).resolves.toEqual({ title: "Launch Storyboard" });
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: "project-1", userId: "user-1" },
      select: { name: true },
    });
  });

  it("falls back when the project is missing", async () => {
    mocks.findUnique.mockResolvedValue(null);

    await expect(
      generateMetadata({ params: Promise.resolve({ id: "missing" }) }),
    ).resolves.toEqual({ title: "Project" });
  });
});
