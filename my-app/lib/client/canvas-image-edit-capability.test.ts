import { describe, expect, it } from "vitest";
import { hasFalImageEditBackend } from "@/components/canvas/image-edit-capability";

describe("hasFalImageEditBackend", () => {
  it("does not unlock Fal-only tools for local or other provider image models", () => {
    expect(
      hasFalImageEditBackend([
        { id: "local:flux" },
        { id: "byok:openai:gpt-image-2" },
      ]),
    ).toBe(false);
  });

  it("unlocks the tools when the connected catalog contains Fal", () => {
    expect(
      hasFalImageEditBackend([
        { id: "byok:fal:fal-ai/flux-pro/v1.1" },
      ]),
    ).toBe(true);
  });
});
