import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLocalWorkspacePreferences: vi.fn(),
  update: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/local-workspace-owner", () => ({
  getLocalWorkspacePreferences: mocks.getLocalWorkspacePreferences,
}));
vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    userSettings: {
      update: mocks.update,
    },
  },
}));

import { clearDefaultsOwnedByProvider } from "@/lib/server/clear-provider-defaults";

describe("clearDefaultsOwnedByProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears only text/image/video defaults owned by the unlinked provider", async () => {
    mocks.getLocalWorkspacePreferences.mockResolvedValue({
      defaultTextModel: "byok:openai:gpt-4.1",
      defaultImageModel: "byok:openai:gpt-image-1",
      defaultVideoModel: "byok:fal:seedance",
    });
    mocks.update.mockResolvedValue({});

    const result = await clearDefaultsOwnedByProvider("user-1", "openai");

    expect(result.cleared).toEqual(["text", "image"]);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: {
        defaultTextModel: "",
        defaultImageModel: "",
      },
    });
  });

  it("leaves unrelated and local defaults untouched", async () => {
    mocks.getLocalWorkspacePreferences.mockResolvedValue({
      defaultTextModel: "local:planner",
      defaultImageModel: "byok:anthropic:claude",
      defaultVideoModel: "byok:fal:seedance",
    });

    const result = await clearDefaultsOwnedByProvider("user-1", "openai");

    expect(result.cleared).toEqual([]);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
