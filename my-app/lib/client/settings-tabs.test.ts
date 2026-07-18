import { describe, expect, it } from "vitest";
import {
  resolveSettingsModelValue,
  retainSettingsTabs,
  shouldMountSettingsTab,
} from "@/components/settings/settings-page";

describe("settings lazy tab mounting", () => {
  it("always mounts an active tab reached by a child-owned URL change", () => {
    const mounted = new Set(["text"] as const);
    expect(shouldMountSettingsTab(mounted, "image", "image")).toBe(true);
    expect(shouldMountSettingsTab(mounted, "image", "status")).toBe(false);
  });

  it("retains both the current and destination tabs across parent navigation", () => {
    const next = retainSettingsTabs(new Set(["text"] as const), "image", "general");
    expect([...next].sort()).toEqual(["general", "image", "text"]);
  });

  it("follows a newly persisted model until the user starts a local draft", () => {
    expect(resolveSettingsModelValue("local:planner", null)).toBe("local:planner");
    expect(resolveSettingsModelValue("local:planner", "byok:openai:gpt-5.4")).toBe(
      "byok:openai:gpt-5.4",
    );
  });
});
