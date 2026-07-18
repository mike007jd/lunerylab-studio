import { describe, expect, it } from "vitest";
import {
  buildProjectActivitySearchParams,
  createCursorPage,
  mergeKeyedCursorPage,
  normalizeCursorPageSize,
} from "@/lib/project-pagination";

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
});
