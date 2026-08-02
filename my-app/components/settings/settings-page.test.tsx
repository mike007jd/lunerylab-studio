import { describe, expect, it } from "vitest";
import {
  buildInstalledLocalTextOptions,
  isVerifiedSettingsDefaultReady,
  resolveSettingsModelValue,
} from "@/components/settings/settings-page";
import { isPersistedDefaultUnavailable } from "@/components/settings/settings-capability-default-card";

describe("Settings image-model default", () => {
  it("keeps an empty persisted default empty until the user chooses a model", () => {
    expect(resolveSettingsModelValue("", null)).toBe("");
  });

  it("distinguishes an explicit clear from an untouched persisted model", () => {
    expect(resolveSettingsModelValue("local:installed-model", null)).toBe("local:installed-model");
    expect(resolveSettingsModelValue("local:installed-model", "")).toBe("");
  });
});

describe("Settings return readiness", () => {
  it("does not leave Settings for a stale persisted default after catalog settlement", () => {
    expect(isVerifiedSettingsDefaultReady(
      "local:removed-model",
      [{ id: "local:installed-model" }],
      false,
      false,
    )).toBe(false);
    expect(isPersistedDefaultUnavailable(
      "local:removed-model",
      [{ id: "local:installed-model" }],
      false,
      false,
    )).toBe(true);
    expect(isVerifiedSettingsDefaultReady(
      "local:installed-model",
      [{ id: "local:installed-model" }],
      true,
      false,
    )).toBe(false);
  });

  it("accepts only a settled catalog option as ready", () => {
    expect(isVerifiedSettingsDefaultReady(
      "local:installed-model",
      [{ id: "local:installed-model" }],
      false,
      false,
    )).toBe(true);
  });

  it("builds local text options only from independently installed inventory", () => {
    expect(buildInstalledLocalTextOptions({
      installed: {
        id: "installed",
        label: "Installed model",
        capability: "planner-llm",
        installed: true,
        partial: false,
        installedFiles: 1,
        fileCount: 1,
        installedBytes: 1,
        totalBytes: 1,
        missingFiles: [],
      },
      removed: {
        id: "removed",
        label: "Removed model",
        capability: "planner-llm",
        installed: false,
        partial: false,
        installedFiles: 0,
        fileCount: 1,
        installedBytes: 0,
        totalBytes: 1,
        missingFiles: ["removed.gguf"],
      },
    })).toEqual([{ id: "local:installed", label: "Local — Installed model" }]);
  });
});
