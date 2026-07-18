import { describe, expect, it } from "vitest";
import type { ByokProviderMeta } from "@/lib/byok-providers";
import { formatProviderCapabilities } from "@/lib/provider-capabilities";

const copy = {
  capabilityText: "text",
  capabilityImage: "image",
  capabilityVideo: "video",
  capability3d: "3D",
};

function providerMeta(overrides: Partial<ByokProviderMeta>): ByokProviderMeta {
  return {
    id: "test",
    label: "Test",
    defaultEndpoint: "https://example.com",
    capabilities: [],
    requiresEndpoint: false,
    requiresModelId: true,
    sourceEvidence: {
      label: "Test source",
      url: "https://example.com/docs",
      lastVerifiedAt: "2026-06-17",
    },
    freshnessExpiresAt: "2026-07-17",
    imageApiMode: "none",
    ...overrides,
  };
}

describe("formatProviderCapabilities", () => {
  it("includes video for text and video providers", () => {
    expect(
      formatProviderCapabilities(
        providerMeta({ capabilities: ["text", "video"], videoApiMode: "minimax" }),
        copy,
      ),
    ).toBe("text / video");
  });

  it("includes video between image and 3D for multi-modal providers", () => {
    expect(
      formatProviderCapabilities(
        providerMeta({
          capabilities: ["image", "image-edit", "video", "model-3d"],
          imageApiMode: "fal",
          videoApiMode: "fal",
          modelApiMode: "fal",
        }),
        copy,
      ),
    ).toBe("image / video / 3D");
  });

  it("does not show image when the provider has no image API mode", () => {
    expect(
      formatProviderCapabilities(
        providerMeta({
          capabilities: ["image", "video"],
          imageApiMode: "none",
          videoApiMode: "replicate",
        }),
        copy,
      ),
    ).toBe("video");
  });
});
