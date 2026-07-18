import { describe, expect, it } from "vitest";
import { desktopBridgeDisabledReason } from "@/components/settings/desktop-runtime/utils";

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
});
