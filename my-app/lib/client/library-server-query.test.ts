import { describe, expect, it } from "vitest";
import {
  buildLibrarySearchParams,
  getVisibleLibraryTabs,
  mergeLibraryServerSearchPage,
  shouldUseServerLibraryQuery,
} from "@/lib/client/library-server-query";

describe("getVisibleLibraryTabs", () => {
  it("always exposes recoverable Trash even when it is empty", () => {
    expect(
      getVisibleLibraryTabs({ all: 2, generated: 2, reference: 0, template: 0, output: 0, trash: 0 }),
    ).toEqual(["all", "generated", "reference", "trash"]);
  });

  it("adds output before Trash when video assets exist", () => {
    expect(
      getVisibleLibraryTabs({ all: 3, generated: 3, reference: 0, template: 0, output: 1, trash: 2 }),
    ).toEqual(["all", "generated", "reference", "output", "trash"]);
  });

  it("adds Template when cloned template assets exist", () => {
    expect(
      getVisibleLibraryTabs({ all: 2, generated: 0, reference: 0, template: 2, output: 0, trash: 0 }),
    ).toEqual(["all", "generated", "reference", "template", "trash"]);
  });
});

describe("library server query", () => {
  it("keeps the hydrated all-assets view local until the user filters", () => {
    expect(shouldUseServerLibraryQuery("", "all")).toBe(false);
    expect(shouldUseServerLibraryQuery("  ", "all")).toBe(false);
    expect(shouldUseServerLibraryQuery("moon", "all")).toBe(true);
    expect(shouldUseServerLibraryQuery("", "reference")).toBe(true);
  });

  it("maps each user-facing tab to the server filter contract", () => {
    expect(buildLibrarySearchParams({ query: "  moon  ", tab: "generated" }).toString())
      .toBe("limit=200&q=moon&kind=GENERATED&origin=USER");
    expect(buildLibrarySearchParams({ query: "", tab: "reference" }).toString())
      .toBe("limit=200&kind=REFERENCE&origin=USER");
    expect(buildLibrarySearchParams({ query: "", tab: "output" }).toString())
      .toBe("limit=200&modality=VIDEO&origin=USER");
    expect(buildLibrarySearchParams({ query: "", tab: "template" }).toString())
      .toBe("limit=200&origin=TEMPLATE");
  });

  it("preserves project scope and cursor paging", () => {
    const params = buildLibrarySearchParams({
      query: "portrait",
      tab: "all",
      projectId: "project-1",
      cursor: "asset-200",
    });
    expect(Object.fromEntries(params)).toEqual({
      limit: "200",
      q: "portrait",
      projectId: "project-1",
      cursor: "asset-200",
    });
  });

  it("supports a row-free count refresh after a library mutation", () => {
    const params = buildLibrarySearchParams({
      query: "",
      tab: "all",
      projectId: "project-1",
      countsOnly: true,
    });
    expect(Object.fromEntries(params)).toEqual({
      limit: "200",
      projectId: "project-1",
      countsOnly: "1",
    });
  });

  it("does not let a stale cursor response overwrite a newer query", () => {
    const current = {
      key: "query-b",
      assets: [{ id: "asset-b" }],
      nextCursor: "cursor-b",
      hasMore: true,
      counts: { all: 1, generated: 1, reference: 0, template: 0, output: 0, trash: 0 },
    };
    const stalePage = {
      assets: [{ id: "asset-a" }],
      nextCursor: null,
      hasMore: false,
      counts: { all: 99, generated: 99, reference: 0, template: 0, output: 0, trash: 0 },
    };

    expect(mergeLibraryServerSearchPage(current, "query-a", stalePage)).toBe(current);
  });

  it("deduplicates the current cursor page and adopts its latest counts", () => {
    const current = {
      key: "query-a",
      assets: [{ id: "asset-1" }, { id: "asset-2" }],
      nextCursor: "cursor-2",
      hasMore: true,
      counts: { all: 2, generated: 2, reference: 0, template: 0, output: 0, trash: 0 },
    };
    const next = mergeLibraryServerSearchPage(current, "query-a", {
      assets: [{ id: "asset-2" }, { id: "asset-3" }],
      nextCursor: null,
      hasMore: false,
      counts: { all: 3, generated: 2, reference: 1, template: 0, output: 1, trash: 0 },
    });

    expect(next).toEqual({
      key: "query-a",
      assets: [{ id: "asset-1" }, { id: "asset-2" }, { id: "asset-3" }],
      nextCursor: null,
      hasMore: false,
      counts: { all: 3, generated: 2, reference: 1, template: 0, output: 1, trash: 0 },
    });
  });
});
