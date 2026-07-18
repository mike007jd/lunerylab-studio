import { describe, expect, it } from "vitest";

import { resolveHuggingFaceModelFileUrl } from "./hf-import-url";

describe("resolveHuggingFaceModelFileUrl", () => {
  it("accepts canonical /resolve/ model artifact URLs", () => {
    expect(
      resolveHuggingFaceModelFileUrl("https://huggingface.co/org/repo/resolve/main/model.gguf"),
    ).toEqual({
      url: "https://huggingface.co/org/repo/resolve/main/model.gguf",
      fileName: "model.gguf",
    });
  });

  it("normalizes /blob/ browser URLs to /resolve/ artifact URLs", () => {
    expect(
      resolveHuggingFaceModelFileUrl("https://huggingface.co/org/repo/blob/main/model.safetensors"),
    ).toEqual({
      url: "https://huggingface.co/org/repo/resolve/main/model.safetensors",
      fileName: "model.safetensors",
    });
  });

  it("strips query and fragment so import ids stay canonical", () => {
    expect(
      resolveHuggingFaceModelFileUrl(
        "https://huggingface.co/org/repo/blob/main/model.bin?download=true#readme",
      ),
    ).toEqual({
      url: "https://huggingface.co/org/repo/resolve/main/model.bin",
      fileName: "model.bin",
    });
  });

  it("rejects page URLs, non-HF URLs, HTTP, unsupported extensions, and missing file names", () => {
    const rejected = [
      "https://huggingface.co/org/repo/tree/main",
      "https://attacker.example/org/repo/resolve/main/model.gguf",
      "http://huggingface.co/org/repo/resolve/main/model.gguf",
      "https://huggingface.co/org/repo/resolve/main/model.txt",
      "https://huggingface.co/org/repo/resolve/main/",
    ];

    for (const url of rejected) {
      expect(resolveHuggingFaceModelFileUrl(url)).toHaveProperty("error");
    }
  });
});

