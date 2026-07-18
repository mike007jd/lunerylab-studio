import { describe, expect, it } from "vitest";
import {
  snapshotsDiffer,
  type BootstrapSnapshot,
} from "@/lib/client/use-bootstrap-snapshot";

function snapshot(): BootstrapSnapshot {
  return {
    user: null,
    app: {
      defaultLocale: "en",
      defaultTextModel: "",
      defaultImageModel: "",
      defaultVideoModel: "",
    },
    features: { imageGeneration: true },
    providers: { openai: { configured: true, source: "keychain" } },
    providerConnections: {
      openai: {
        endpoint: "https://api.openai.com/v1",
        models: { text: "gpt-5.4" },
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
    },
  };
}

describe("bootstrap snapshot provider connections", () => {
  it("keeps an unchanged profile snapshot stable", () => {
    expect(snapshotsDiffer(snapshot(), snapshot())).toBe(false);
  });

  it("invalidates consumers when a profile-owned model selection changes", () => {
    const previous = snapshot();
    const next = snapshot();
    next.providerConnections.openai = {
      ...next.providerConnections.openai!,
      models: { text: "gpt-5.5" },
      updatedAt: "2026-07-13T00:01:00.000Z",
    };
    expect(snapshotsDiffer(previous, next)).toBe(true);
  });

  it("invalidates consumers when a provider connection is removed", () => {
    const previous = snapshot();
    const next = snapshot();
    next.providerConnections = {};
    expect(snapshotsDiffer(previous, next)).toBe(true);
  });
});
