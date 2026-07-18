import { describe, expect, it } from "vitest";
import {
  addCanvasEntrySource,
  resolveCanvasReturnTarget,
} from "@/lib/client/creation-flow";
import {
  formatGenerationOptionsSummary,
  resolveCssAspectRatio,
} from "@/lib/client/generation-presentation";

describe("creation flow presentation", () => {
  it("adds a Studio source without trusting an external origin", () => {
    expect(addCanvasEntrySource("https://evil.example/canvas/session?x=1", "studio"))
      .toBe("/canvas/session?x=1&source=studio");
    expect(() => addCanvasEntrySource("javascript:alert(1)", "studio")).toThrow(
      "outside the supported route",
    );
  });

  it("allows only fixed Canvas return targets", () => {
    expect(resolveCanvasReturnTarget("studio")).toEqual({ href: "/studio", label: "studio" });
    expect(resolveCanvasReturnTarget("project:project-1")).toEqual({
      href: "/projects/project-1",
      label: "projects",
    });
    expect(resolveCanvasReturnTarget("https://evil.example")).toEqual({
      href: "/library",
      label: "library",
    });
    expect(resolveCanvasReturnTarget("project:../../settings")).toEqual({
      href: "/library",
      label: "library",
    });
  });

  it("writes only safe project source tokens", () => {
    expect(addCanvasEntrySource("/canvas/session", "project:project-1")).toBe(
      "/canvas/session?source=project%3Aproject-1",
    );
    expect(() => addCanvasEntrySource("/canvas/session", "project:../settings")).toThrow(
      "outside the supported return targets",
    );
  });

  it("formats compact generation summaries", () => {
    expect(formatGenerationOptionsSummary("16:9", 4)).toBe("16:9 · ×4");
  });

  it("prefers intrinsic dimensions and safely falls back", () => {
    expect(resolveCssAspectRatio("1:1", 1600, 900)).toBe("1600 / 900");
    expect(resolveCssAspectRatio("3:4")).toBe("3 / 4");
    expect(resolveCssAspectRatio("Auto")).toBe("1 / 1");
  });
});
