import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseRequestedAspectRatio } from "@/lib/server/byok-shared";
import {
  assertReferenceLimit,
  parseRequestedImageCount,
} from "@/lib/server/generate-request";
import { clampBboxToImage } from "@/lib/server/image-compose";
import { ApiError } from "@/lib/server/errors";

describe("parseRequestedAspectRatio (#5)", () => {
  it("accepts supported ratios and passes them through", () => {
    expect(parseRequestedAspectRatio("16:9")).toBe("16:9");
    expect(parseRequestedAspectRatio(" 1:1 ")).toBe("1:1");
  });

  it("treats absent/blank as undefined (use the model default)", () => {
    expect(parseRequestedAspectRatio(undefined)).toBeUndefined();
    expect(parseRequestedAspectRatio(null)).toBeUndefined();
    expect(parseRequestedAspectRatio("   ")).toBeUndefined();
  });

  it("rejects an unsupported ratio with a 400 instead of snapping to 1:1", () => {
    expect(() => parseRequestedAspectRatio("2:1")).toThrow(ApiError);
    try {
      parseRequestedAspectRatio("2:1");
    } catch (error) {
      expect((error as ApiError).status).toBe(400);
      expect((error as ApiError).code).toBe("unsupported_aspect_ratio");
    }
    expect(() => parseRequestedAspectRatio("garbage")).toThrow(ApiError);
  });
});

describe("assertReferenceLimit (#6)", () => {
  it("allows up to 4 total references", () => {
    expect(() => assertReferenceLimit(4, 0)).not.toThrow();
    expect(() => assertReferenceLimit(2, 2)).not.toThrow();
    expect(() => assertReferenceLimit(0, 0)).not.toThrow();
  });

  it("rejects a 5th reference (files + asset ids) with a 400", () => {
    expect(() => assertReferenceLimit(3, 2)).toThrow(ApiError);
    try {
      assertReferenceLimit(3, 2);
    } catch (error) {
      expect((error as ApiError).status).toBe(400);
      expect((error as ApiError).code).toBe("too_many_references");
    }
  });
});

describe("parseRequestedImageCount", () => {
  it("defaults an omitted count to one and accepts the supported range", () => {
    expect(parseRequestedImageCount(null)).toBe(1);
    expect(parseRequestedImageCount(" 1 ")).toBe(1);
    expect(parseRequestedImageCount("4")).toBe(4);
  });

  it("rejects malformed or out-of-range values instead of maximizing spend", () => {
    for (const value of ["garbage", "1.5", "0", "5", "-1"]) {
      expect(() => parseRequestedImageCount(value)).toThrow(ApiError);
      try {
        parseRequestedImageCount(value);
      } catch (error) {
        expect((error as ApiError).status).toBe(400);
        expect((error as ApiError).code).toBe("invalid_generation_count");
      }
    }
  });
});

describe("clampBboxToImage (#9)", () => {
  it("clamps an out-of-range bbox inside the image bounds", () => {
    expect(clampBboxToImage({ x: 90, y: 90, width: 50, height: 50 }, 100, 100)).toEqual({
      left: 90,
      top: 90,
      width: 10,
      height: 10,
    });
  });

  it("coerces NaN / negative values to a valid finite rect", () => {
    expect(clampBboxToImage({ x: NaN, y: -20, width: NaN, height: -5 }, 100, 100)).toEqual({
      left: 0,
      top: 0,
      width: 1,
      height: 1,
    });
  });

  it("keeps an in-bounds bbox unchanged", () => {
    expect(clampBboxToImage({ x: 10, y: 20, width: 30, height: 40 }, 200, 200)).toEqual({
      left: 10,
      top: 20,
      width: 30,
      height: 40,
    });
  });
});
