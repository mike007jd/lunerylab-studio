import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseReferenceSetAssetIds } from "@/lib/server/reference-set";

describe("parseReferenceSetAssetIds", () => {
  it("trims values, drops empty strings, and keeps first unique ids", () => {
    expect(parseReferenceSetAssetIds([" asset-a ", "", "asset-b", "asset-a", "  ", "asset-c"])).toEqual([
      "asset-a",
      "asset-b",
      "asset-c",
    ]);
  });

  it("ignores non-string array items", () => {
    expect(parseReferenceSetAssetIds(["asset-a", 12, null, "asset-b", { id: "asset-c" }])).toEqual([
      "asset-a",
      "asset-b",
    ]);
  });

  it("returns null for non-array input", () => {
    expect(parseReferenceSetAssetIds("asset-a")).toBeNull();
    expect(parseReferenceSetAssetIds(undefined)).toBeNull();
  });
});
