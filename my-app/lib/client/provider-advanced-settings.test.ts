import { describe, expect, it } from "vitest";
import { shouldOpenProviderAdvancedSettings } from "@/components/settings/desktop-runtime/utils";

describe("provider advanced settings visibility", () => {
  it("opens when an explicit model id is required", () => {
    expect(
      shouldOpenProviderAdvancedSettings({ requiresEndpoint: false, requiresModelId: true }),
    ).toBe(true);
  });

  it("stays collapsed only when neither endpoint nor model is required", () => {
    expect(
      shouldOpenProviderAdvancedSettings({ requiresEndpoint: false, requiresModelId: false }),
    ).toBe(false);
  });
});
