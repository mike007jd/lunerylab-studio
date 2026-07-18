import { describe, expect, it } from "vitest";
import { isDesktopOnlyRoute } from "@/lib/desktop-runtime";

describe("isDesktopOnlyRoute", () => {
  it("keeps every Studio workspace surface inside the desktop runtime", () => {
    expect(isDesktopOnlyRoute("/studio")).toBe(true);
    expect(isDesktopOnlyRoute("/studio/agent/thread-1")).toBe(true);
    expect(isDesktopOnlyRoute("/projects/project-1")).toBe(true);
    expect(isDesktopOnlyRoute("/library")).toBe(true);
    expect(isDesktopOnlyRoute("/settings")).toBe(true);
    expect(isDesktopOnlyRoute("/canvas/session-1")).toBe(true);
    expect(isDesktopOnlyRoute("/tools")).toBe(true);
    expect(isDesktopOnlyRoute("/workflow-kits")).toBe(true);
  });

  it("keeps the root entry outside the desktop route matcher", () => {
    expect(isDesktopOnlyRoute("/")).toBe(false);
  });

  it("redirects retired monetization/account surfaces if they are requested", () => {
    expect(isDesktopOnlyRoute("/billing")).toBe(true);
    expect(isDesktopOnlyRoute("/license")).toBe(true);
  });
});
