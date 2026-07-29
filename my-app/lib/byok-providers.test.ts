import { describe, expect, it } from "vitest";
import {
  byokModelInputRoles,
  findByokProvider,
  normalizeByokModels,
  resolveByokModelGuidance,
  type ByokProviderMeta,
} from "@/lib/byok-providers";

function meta(id: string): ByokProviderMeta {
  const found = findByokProvider(id);
  if (!found) throw new Error(`missing provider ${id}`);
  return found;
}

describe("byokModelInputRoles", () => {
  it("splits a multi-capability provider into one slot per usable model", () => {
    // OpenAI does text + image (+ edit, which folds into the image model).
    expect(byokModelInputRoles(meta("openai"))).toEqual(["text", "imageGenerate"]);
    // fal generates image, video and 3D — three distinct user-picked models.
    expect(byokModelInputRoles(meta("fal"))).toEqual(["imageGenerate", "video", "model3d"]);
    expect(byokModelInputRoles(meta("minimax"))).toEqual(["text", "video"]);
  });

  it("returns the single slot for single-capability providers", () => {
    expect(byokModelInputRoles(meta("anthropic"))).toEqual(["text"]);
  });

  it("asks for no model id when the operation is fixed (meshy/tripo)", () => {
    expect(byokModelInputRoles(meta("meshy"))).toEqual([]);
    expect(byokModelInputRoles(meta("tripo"))).toEqual([]);
  });
});

describe("resolveByokModelGuidance", () => {
  it("keeps OpenAI text and image examples capability-specific", () => {
    expect(resolveByokModelGuidance(meta("openai"), ["text"])).toMatchObject({
      placeholderModelId: "gpt-5.6-sol",
      sourceEvidence: {
        url: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
        lastVerifiedAt: "2026-07-29",
      },
    });
    expect(resolveByokModelGuidance(meta("openai"), ["imageGenerate"])).toMatchObject({
      placeholderModelId: "gpt-image-2",
      sourceEvidence: {
        url: "https://developers.openai.com/api/docs/models/gpt-image-2",
      },
    });
  });

  it("never leaks one provider-wide example into a different capability", () => {
    expect(resolveByokModelGuidance(meta("minimax"), ["text"])).toMatchObject({
      placeholderModelId: "MiniMax-M3",
      sourceEvidence: { url: "https://platform.minimax.io/docs/api-reference/text-openai-api" },
    });
    const replicateVideo = resolveByokModelGuidance(meta("replicate"), ["video"]);
    expect(replicateVideo).toMatchObject({
      sourceEvidence: { url: "https://replicate.com/collections/text-to-video" },
    });
    expect(replicateVideo?.placeholderModelId).toBeUndefined();
  });

  it("gives every multi-slot settings role an authoritative destination", () => {
    for (const providerId of [
      "openai",
      "minimax",
      "replicate",
      "fal",
      "together",
      "fireworks",
      "openai-compatible",
    ]) {
      const provider = meta(providerId);
      for (const role of byokModelInputRoles(provider)) {
        const guidance = resolveByokModelGuidance(provider, [role]);
        expect(guidance, `${providerId}:${role}`).toBeDefined();
        expect(
          Boolean(guidance?.sourceEvidence?.url) || guidance?.modelIdFromEndpoint === true,
          `${providerId}:${role}`,
        ).toBe(true);
      }
    }
  });

  it("treats the configured /models response as authority for compatible endpoints", () => {
    const guidance = resolveByokModelGuidance(meta("openai-compatible"), ["text"]);
    expect(guidance).toMatchObject({
      placeholderModelId: "local-model-id",
      modelIdFromEndpoint: true,
    });
    expect(guidance?.sourceEvidence).toBeUndefined();
  });

  it("preserves guidance for a genuinely single-slot provider", () => {
    expect(resolveByokModelGuidance(meta("anthropic"), ["text"])).toMatchObject({
      placeholderModelId: "claude-sonnet-4-6",
      sourceEvidence: {
        url: "https://platform.claude.com/docs/en/about-claude/models/overview",
      },
    });
  });
});

describe("normalizeByokModels", () => {
  it("keeps known non-blank slots and drops everything else", () => {
    expect(
      normalizeByokModels({
        text: "  gpt-5-chat-latest  ",
        imageGenerate: "gpt-image-1.5",
        video: "   ",
        bogus: "nope",
      }),
    ).toEqual({ text: "gpt-5-chat-latest", imageGenerate: "gpt-image-1.5" });
  });

  it("returns undefined when nothing usable remains", () => {
    expect(normalizeByokModels({})).toBeUndefined();
    expect(normalizeByokModels({ text: "" })).toBeUndefined();
    expect(normalizeByokModels(null)).toBeUndefined();
    expect(normalizeByokModels("oops")).toBeUndefined();
  });
});
