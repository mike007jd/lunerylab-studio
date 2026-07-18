import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  groupBy: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: { asset: { groupBy: mocks.groupBy, count: mocks.count } },
}));

import {
  fetchLibraryAssetCounts,
  withVisibleLibraryAssetScope,
} from "@/lib/server/library-asset-counts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.groupBy.mockResolvedValue([
    { kind: "GENERATED", modality: "IMAGE", origin: "USER", _count: { _all: 1 } },
    { kind: "GENERATED", modality: "IMAGE", origin: "TEMPLATE", _count: { _all: 2 } },
  ]);
  mocks.count.mockResolvedValue(1);
});

describe("visible Library asset scope", () => {
  it("excludes original template projects while retaining unassigned and copied assets", () => {
    expect(withVisibleLibraryAssetScope({ userId: "user-1" })).toEqual({
      AND: [
        { userId: "user-1" },
        {
          OR: [
            { projectId: null },
            { project: { is: { isTemplate: false } } },
          ],
        },
      ],
    });
  });

  it("groups by origin and reports template content separately", async () => {
    await expect(fetchLibraryAssetCounts({ userId: "user-1" })).resolves.toEqual({
      all: 3,
      generated: 1,
      reference: 0,
      template: 2,
      output: 0,
      trash: 1,
    });
    expect(mocks.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ["kind", "modality", "origin"] }),
    );
  });
});
