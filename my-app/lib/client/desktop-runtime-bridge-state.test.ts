import { describe, expect, it } from "vitest";
import {
  desktopBridgeDisabledReason,
  providerSecretSourceLabel,
} from "@/components/settings/desktop-runtime/utils";

const copy = {
  checking: "Checking desktop connection…",
  unavailable: "Open the desktop app to save keys.",
};

describe("desktop bridge action state", () => {
  it("keeps initial loading distinct from a confirmed unavailable bridge", () => {
    expect(desktopBridgeDisabledReason("loading", copy)).toBe(copy.checking);
    expect(desktopBridgeDisabledReason("unavailable", copy)).toBe(copy.unavailable);
  });

  it("lets field validation explain disabled actions once the bridge is ready", () => {
    expect(desktopBridgeDisabledReason("ready", copy)).toBeUndefined();
  });

  it("keeps an unavailable keychain distinct from a missing provider connection", () => {
    const labels = {
      env: "environment",
      keychain: "keychain",
      keychainUnavailable: "keychain unavailable",
      saved: "saved",
      notConnected: "not connected",
    };

    expect(
      providerSecretSourceLabel(
        { source: "none", keychain_status: "unavailable" },
        true,
        false,
        labels,
      ),
    ).toBe(labels.keychainUnavailable);
    expect(
      providerSecretSourceLabel(
        { source: "none", keychain_status: "missing" },
        true,
        false,
        labels,
      ),
    ).toBe(labels.notConnected);
    expect(
      providerSecretSourceLabel(
        { source: "environment", keychain_status: "unavailable" },
        true,
        false,
        labels,
      ),
    ).toBe(labels.env);
  });
});
