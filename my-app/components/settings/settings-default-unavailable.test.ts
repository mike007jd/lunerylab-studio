import { describe, expect, it } from "vitest";
import { isPersistedDefaultUnavailable } from "@/components/settings/settings-capability-default-card";

describe("settings unavailable default model detection", () => {
  it("treats a non-empty value missing from options as unavailable", () => {
    expect(isPersistedDefaultUnavailable("byok:openai:gone", [])).toBe(true);
    expect(
      isPersistedDefaultUnavailable("byok:openai:gone", [{ id: "byok:openai:other" }]),
    ).toBe(true);
  });

  it("treats empty or resolvable values as available", () => {
    expect(isPersistedDefaultUnavailable("", [])).toBe(false);
    expect(
      isPersistedDefaultUnavailable("byok:openai:gpt-4.1", [{ id: "byok:openai:gpt-4.1" }]),
    ).toBe(false);
  });

  it("does not report a persisted default as unavailable before the catalog settles", () => {
    expect(isPersistedDefaultUnavailable("byok:openai:gpt-4.1", [], true)).toBe(false);
    expect(isPersistedDefaultUnavailable("byok:openai:gpt-4.1", [], false)).toBe(true);
  });

  it("does not offer destructive stale cleanup when the catalog fetch failed", () => {
    expect(isPersistedDefaultUnavailable("byok:openai:gpt-4.1", [], false, true)).toBe(false);
    expect(isPersistedDefaultUnavailable("byok:openai:gpt-4.1", [], false, false)).toBe(true);
  });
});
