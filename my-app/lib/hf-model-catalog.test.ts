import { describe, expect, it } from "vitest";
import {
  findHfModelEntry,
  HF_MODEL_CATALOG,
  MODEL_FRESHNESS_BASELINE,
  modelRunnableState,
} from "./hf-model-catalog";

describe("HF model catalog contracts", () => {
  it("exposes one supported catalog without hidden compatibility entries", () => {
    const ids = HF_MODEL_CATALOG.map((entry) => entry.id);

    expect(ids).toContain("qwen2.5-7b-instruct-q4");
    expect(ids).toContain("llama-3.2-3b-instruct-q4");
    expect(ids).toContain("flux1-schnell-q4");
    expect(ids).toContain("sdxl-base-1.0");
    expect(ids).toContain("sd15-emaonly");
    expect(findHfModelEntry("qwen2.5-7b-instruct-q4")).toBeDefined();
  });

  it("contains only models the desktop downloader can install today", () => {
    expect(MODEL_FRESHNESS_BASELINE).toBe("2026-07-23");
    expect(HF_MODEL_CATALOG.length).toBeGreaterThan(0);
    for (const entry of HF_MODEL_CATALOG) {
      expect(entry.fileName).not.toBe("");
      expect(entry.sourceUrl).toBe(`https://huggingface.co/${entry.hfRepo}`);
      expect(entry.checkedAt).toBe("2026-07-23");
      expect(entry.downloadUrl).toMatch(/^https:\/\/huggingface\.co\//);
      expect(entry.sourceEvidence.length).toBeGreaterThan(0);
      expect(entry.sourceEvidence.every((source) => source.lastVerifiedAt === "2026-07-23")).toBe(true);
    }
  });

  it("exposes FLUX.2 as a runnable multi-file sd-cpp kit", () => {
    const entry = findHfModelEntry("flux2-dev-q4");
    expect(entry).toBeDefined();
    if (!entry) return;

    expect(entry.offlineReady).toBe(true);
    expect(entry.runtimeTarget).toBe("sd-cpp");
    expect(entry.freshnessExpiresAt).toBe("2026-08-22");
    expect(entry.companions?.map((file) => file.fileName)).toEqual([
      "full_encoder_small_decoder.safetensors",
      "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
    ]);
    expect(entry.sizeBytes).toBe(
      19_959_731_168 + 249_519_092 + 14_333_922_848,
    );
  });

  it("keeps real low-memory choices visible and hardware-gated", () => {
    const entry = findHfModelEntry("qwen2.5-7b-instruct-q4");
    expect(entry).toBeDefined();
    if (!entry) return;

    expect(modelRunnableState(entry, { ram_gb: 16, apple_silicon: true }, false, true)).toBe("not_downloaded");
    expect(modelRunnableState(entry, { ram_gb: 16, apple_silicon: true }, true, undefined)).toBe("downloaded");
    expect(modelRunnableState(entry, { ram_gb: 16, apple_silicon: true }, true, false)).toBe("missing_runtime");
    expect(modelRunnableState(entry, { ram_gb: 4, apple_silicon: true }, true, true)).toBe("hardware_unfit");
  });
});
