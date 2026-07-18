import { describe, expect, it } from "vitest";
import { summarizeLibraryAssetCountGroups } from "@/lib/library-search";

describe("library search counts", () => {
  it("derives tab and video-output totals from one grouped result", () => {
    expect(
      summarizeLibraryAssetCountGroups([
        { kind: "GENERATED", modality: "IMAGE", origin: "USER", _count: { _all: 4 } },
        { kind: "GENERATED", modality: "VIDEO", origin: "USER", _count: { _all: 2 } },
        { kind: "REFERENCE", modality: "IMAGE", origin: "USER", _count: { _all: 3 } },
        { kind: "REFERENCE", modality: "VIDEO", origin: "USER", _count: { _all: 1 } },
        { kind: "GENERATED", modality: "IMAGE", origin: "TEMPLATE", _count: { _all: 2 } },
      ]),
    ).toEqual({
      all: 12,
      generated: 6,
      reference: 4,
      template: 2,
      output: 3,
      trash: 0,
    });
  });

  it("returns zeroes for an empty library", () => {
    expect(summarizeLibraryAssetCountGroups([])).toEqual({
      all: 0,
      generated: 0,
      reference: 0,
      template: 0,
      output: 0,
      trash: 0,
    });
  });
});
