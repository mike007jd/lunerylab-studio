import { describe, expect, it } from "vitest";
import {
  PROJECTS_PAGE_SIZE,
  buildProjectActivitySearchParams,
  createCursorPage,
  mergeKeyedCursorPage,
  normalizeCursorPageSize,
  refillRecentProjects,
  removeItemFromKeyedCursorPage,
} from "@/lib/project-pagination";
import { SIDEBAR_RECENT_PROJECT_LIMIT } from "@/lib/constants/shell-navigation";

describe("project cursor pagination", () => {
  it("keeps an exact boundary terminal and uses the last retained id as cursor", () => {
    expect(createCursorPage([{ id: "1" }, { id: "2" }], 2)).toEqual({
      items: [{ id: "1" }, { id: "2" }],
      hasMore: false,
      nextCursor: null,
    });
    expect(createCursorPage([{ id: "1" }, { id: "2" }, { id: "3" }], 2)).toEqual({
      items: [{ id: "1" }, { id: "2" }],
      hasMore: true,
      nextCursor: "2",
    });
  });

  it("clamps invalid and oversized page sizes", () => {
    expect(normalizeCursorPageSize(undefined, 24, 100)).toBe(24);
    expect(normalizeCursorPageSize(Number.NaN, 24, 100)).toBe(24);
    expect(normalizeCursorPageSize(0, 24, 100)).toBe(1);
    expect(normalizeCursorPageSize(500, 24, 100)).toBe(100);
  });

  it("builds independent job and canvas cursors", () => {
    expect(Object.fromEntries(buildProjectActivitySearchParams("jobs", "job-6"))).toEqual({
      section: "jobs",
      jobsCursor: "job-6",
    });
    expect(
      Object.fromEntries(buildProjectActivitySearchParams("canvasSessions", "session-12")),
    ).toEqual({
      section: "canvasSessions",
      canvasSessionsCursor: "session-12",
    });
  });

  it("ignores a stale project response instead of merging it into the active project", () => {
    const current = {
      key: "project-b",
      items: [{ id: "b-1" }],
      hasMore: true,
      nextCursor: "b-1",
    };
    expect(
      mergeKeyedCursorPage(current, "project-a", {
        items: [{ id: "a-2" }],
        hasMore: false,
        nextCursor: null,
      }),
    ).toBe(current);
  });

  it("deduplicates the active page and adopts its terminal cursor state", () => {
    expect(
      mergeKeyedCursorPage(
        {
          key: "project-a",
          items: [{ id: "1" }, { id: "2" }],
          hasMore: true,
          nextCursor: "2",
        },
        "project-a",
        {
          items: [{ id: "2" }, { id: "3" }],
          hasMore: false,
          nextCursor: null,
        },
      ),
    ).toEqual({
      key: "project-a",
      items: [{ id: "1" }, { id: "2" }, { id: "3" }],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("keeps Load More reachable after deleting the current cursor in a 25+ list", () => {
    const total = PROJECTS_PAGE_SIZE + 2;
    const ids = Array.from({ length: total }, (_, index) => `p${index + 1}`);
    const firstPage = createCursorPage(
      ids.slice(0, PROJECTS_PAGE_SIZE + 1).map((id) => ({ id })),
      PROJECTS_PAGE_SIZE,
    );
    const deletedCursor = firstPage.nextCursor!;
    expect(firstPage.items).toHaveLength(PROJECTS_PAGE_SIZE);
    expect(deletedCursor).toBe(`p${PROJECTS_PAGE_SIZE}`);

    const afterDelete = removeItemFromKeyedCursorPage(
      {
        key: "projects",
        ...firstPage,
      },
      deletedCursor,
    );

    expect(afterDelete.items).toHaveLength(PROJECTS_PAGE_SIZE - 1);
    expect(afterDelete.hasMore).toBe(true);
    expect(afterDelete.nextCursor).toBe(`p${PROJECTS_PAGE_SIZE - 1}`);
    expect(afterDelete.nextCursor).not.toBe(deletedCursor);

    // Simulate the server page that follows the retargeted cursor after the
    // deleted row is gone: remaining projects after p23 are p25 and p26.
    const remainingAfterCursor = ids
      .filter((id) => id !== deletedCursor)
      .slice(PROJECTS_PAGE_SIZE - 1)
      .map((id) => ({ id }));
    const merged = mergeKeyedCursorPage(afterDelete, "projects", {
      items: remainingAfterCursor,
      hasMore: false,
      nextCursor: null,
    });

    expect(merged.items.map((item) => item.id)).toEqual(ids.filter((id) => id !== deletedCursor));
    expect(merged.items).toHaveLength(total - 1);
    expect(merged.hasMore).toBe(false);
  });

  it("refills the six-item recent sidebar from a seven-item candidate page", () => {
    const sidebar = Array.from({ length: SIDEBAR_RECENT_PROJECT_LIMIT }, (_, index) => ({
      id: `s${index + 1}`,
      name: `Project ${index + 1}`,
    }));
    const apiPage = [
      ...sidebar,
      { id: "s7", name: "Project 7" },
    ];

    expect(
      refillRecentProjects(sidebar, new Set(["s3"]), apiPage, SIDEBAR_RECENT_PROJECT_LIMIT),
    ).toEqual([
      { id: "s1", name: "Project 1" },
      { id: "s2", name: "Project 2" },
      { id: "s4", name: "Project 4" },
      { id: "s5", name: "Project 5" },
      { id: "s6", name: "Project 6" },
      { id: "s7", name: "Project 7" },
    ]);
  });

  it("never resurrects any project deleted while an older sidebar refill was in flight", () => {
    const current = [
      { id: "s1" },
      { id: "s3" },
      { id: "s4" },
    ];
    const staleCandidates = [
      { id: "s1" },
      { id: "s2" },
      { id: "s3" },
      { id: "s4" },
      { id: "s5" },
    ];

    expect(
      refillRecentProjects(current, new Set(["s2", "s3"]), staleCandidates, 4),
    ).toEqual([{ id: "s1" }, { id: "s4" }, { id: "s5" }]);
  });
});
