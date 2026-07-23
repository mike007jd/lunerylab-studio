import { describe, expect, it } from "vitest";
import { resolveSettingsModelValue } from "@/components/settings/settings-page";

describe("Settings image-model default", () => {
  it("keeps an empty persisted default empty until the user chooses a model", () => {
    expect(resolveSettingsModelValue("", null)).toBe("");
  });

  it("distinguishes an explicit clear from an untouched persisted model", () => {
    expect(resolveSettingsModelValue("local:installed-model", null)).toBe("local:installed-model");
    expect(resolveSettingsModelValue("local:installed-model", "")).toBe("");
  });
});
