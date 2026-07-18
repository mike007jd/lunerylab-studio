import { describe, expect, it } from "vitest";
import {
  byokModelInputRoles,
  findByokProvider,
  normalizeByokModels,
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
