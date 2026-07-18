import { describe, expect, it, vi } from "vitest";
import {
  PROJECT_NAME_MAX_LENGTH,
  buildDefaultProjectName,
  normalizeProjectName,
} from "@/lib/project-name";

describe("project names", () => {
  it("normalizes valid names and rejects empty or oversized values", () => {
    expect(normalizeProjectName("  Launch board  ")).toBe("Launch board");
    expect(normalizeProjectName("   ")).toBeNull();
    expect(normalizeProjectName("x".repeat(PROJECT_NAME_MAX_LENGTH))).toHaveLength(
      PROJECT_NAME_MAX_LENGTH,
    );
    expect(normalizeProjectName("x".repeat(PROJECT_NAME_MAX_LENGTH + 1))).toBeNull();
  });

  it("builds the localized default through the shared translation contract", () => {
    const t = vi.fn((_key: string, vars?: Record<string, string | number>) =>
      `Project ${vars?.stamp}`,
    );
    const name = buildDefaultProjectName(t, new Date("2026-07-17T00:05:00.000Z"));

    expect(name).toMatch(/^Project \S+/);
    expect(t).toHaveBeenCalledWith("studio.buildProjectName", {
      stamp: expect.any(String),
    });
  });
});
