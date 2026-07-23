import { describe, expect, it } from "vitest";
import {
  COPY,
  capabilityHealthView,
  embeddedEngineHealthView,
  hardwareHealthView,
} from "@/components/settings/runtime-health-panel";
import type { AccelInfo } from "@/lib/desktop-runtime";

const accel: AccelInfo = {
  platform: "macos-arm64",
  gpu: "metal",
  vendor: "Apple Silicon",
};

describe("runtime health capability truth", () => {
  it("does not render a false negative before capability probes settle", () => {
    expect(capabilityHealthView({
      label: COPY.en.imageCapability,
      activeLabel: null,
      ready: false,
      checking: true,
      notReadyDetail: COPY.en.imageNotReady,
      copy: COPY.en,
    })).toMatchObject({ state: "checking", statusLabel: COPY.en.probing });
  });

  it("requires an actual ready model for the top-level capability", () => {
    expect(capabilityHealthView({
      label: COPY.en.imageCapability,
      activeLabel: null,
      ready: false,
      checking: false,
      notReadyDetail: COPY.en.imageNotReady,
      copy: COPY.en,
    })).toMatchObject({ state: "unreachable", statusLabel: COPY.en.notReady });

    expect(capabilityHealthView({
      label: COPY.en.imageCapability,
      activeLabel: "Local Image",
      ready: true,
      checking: false,
      notReadyDetail: COPY.en.imageNotReady,
      copy: COPY.en,
    })).toMatchObject({ state: "ready", detail: "Local Image" });
  });
});

describe("runtime health diagnostic truth", () => {
  it("reports Apple Silicon hardware independently from engine state", () => {
    expect(hardwareHealthView(null, true, COPY.en)).toMatchObject({ state: "checking" });
    expect(hardwareHealthView(null, false, COPY.en)).toMatchObject({ statusLabel: COPY.en.checkFailed });
    expect(hardwareHealthView(accel, false, COPY.en)).toMatchObject({
      state: "ready",
      statusLabel: COPY.en.detected,
    });
  });

  it("describes a packaged image engine as installed, not image capability connected", () => {
    expect(embeddedEngineHealthView({
      runtime: { id: "sd-cpp", status: "ready", installed: true },
      label: COPY.en.builtInImageEngine,
      checking: false,
      readyMeansInstalled: true,
      copy: COPY.en,
    })).toMatchObject({ state: "ready", statusLabel: COPY.en.installed });
  });

  it("keeps engine setup and absence distinct", () => {
    expect(embeddedEngineHealthView({
      runtime: { id: "llama-cpp", status: "downloading", installed: true },
      label: COPY.en.builtInTextEngine,
      checking: false,
      copy: COPY.en,
    })).toMatchObject({ state: "pending", statusLabel: COPY.en.pending });
    expect(embeddedEngineHealthView({
      runtime: { id: "llama-cpp", status: "idle", installed: false },
      label: COPY.en.builtInTextEngine,
      checking: false,
      copy: COPY.en,
    })).toMatchObject({ state: "unreachable", statusLabel: COPY.en.notInstalled });
  });
});
