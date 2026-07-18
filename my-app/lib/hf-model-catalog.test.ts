import { describe, expect, it } from "vitest";
import {
  compatibilityFallbackForHardware,
  findHfModelEntry,
  hasFlagshipModelForHardware,
  HF_MODEL_CATALOG,
  HF_MODEL_REGISTRY,
  listFirstRunImageModelEntries,
  modelRunnableState,
} from "./hf-model-catalog";

describe("HF model catalog contracts", () => {
  it("keeps compatibility models out of the visible catalog but resolvable in the registry", () => {
    const compatibilityId = "qwen2.5-7b-instruct-q4";

    expect((HF_MODEL_CATALOG as readonly { id: string }[]).some((entry) => entry.id === compatibilityId)).toBe(false);
    expect((HF_MODEL_REGISTRY as readonly { id: string }[]).some((entry) => entry.id === compatibilityId)).toBe(true);
    expect(findHfModelEntry(compatibilityId)?.lifecycleStatus).toBe("compatibility");
  });

  it("keeps small image models available to the first-run model center", () => {
    expect(listFirstRunImageModelEntries().map((entry) => entry.id)).toEqual([
      "flux1-schnell-q4",
      "sdxl-base-1.0",
      "sd15-emaonly",
    ]);
  });

  it("exposes FLUX.2 as a runnable multi-file sd-cpp kit", () => {
    const entry = findHfModelEntry("flux2-dev-q4");
    expect(entry).toBeDefined();
    if (!entry) return;

    expect(entry.lifecycleStatus).toBe("current");
    expect(entry.offlineReady).toBe(true);
    expect(entry.runtimeTarget).toBe("sd-cpp");
    expect(entry.freshnessExpiresAt).toBe("2026-08-02");
    expect(entry.companions?.map((file) => file.fileName)).toEqual([
      "full_encoder_small_decoder.safetensors",
      "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
    ]);
    expect(entry.sizeBytes).toBe(
      19_959_731_168 + 249_519_092 + 14_333_922_848,
    );
  });

  it("derives runnable state without treating unknown runtime as missing", () => {
    const entry = findHfModelEntry("qwen2.5-7b-instruct-q4");
    expect(entry).toBeDefined();
    if (!entry) return;

    expect(modelRunnableState(entry, { ram_gb: 16, apple_silicon: true }, false, true)).toBe("not_downloaded");
    expect(modelRunnableState(entry, { ram_gb: 16, apple_silicon: true }, true, undefined)).toBe("downloaded");
    expect(modelRunnableState(entry, { ram_gb: 16, apple_silicon: true }, true, false)).toBe("missing_runtime");
    expect(modelRunnableState(entry, { ram_gb: 4, apple_silicon: true }, true, true)).toBe("hardware_unfit");
  });
});

describe("low-spec hardware compatibility fallback (#10)", () => {
  const lowSpecIntel = { ram_gb: 8, apple_silicon: false } as const;
  const midSpecApple = { ram_gb: 16, apple_silicon: true } as const;
  const highSpec = { ram_gb: 64, apple_silicon: true } as const;

  it("reports no flagship fit on common 8GB/16GB machines", () => {
    expect(hasFlagshipModelForHardware(lowSpecIntel)).toBe(false);
    expect(hasFlagshipModelForHardware(midSpecApple)).toBe(false);
  });

  it("surfaces at least one compatible TEXT model when no flagship fits", () => {
    const fallback = compatibilityFallbackForHardware(lowSpecIntel);
    expect(fallback.length).toBeGreaterThanOrEqual(1);
    expect(fallback.length).toBeLessThanOrEqual(2);
    // The text planner is prioritized first — a low-spec machine needs an LLM.
    expect(fallback[0]?.capability).toBe("planner-llm");
    // Every surfaced candidate actually fits this machine.
    for (const entry of fallback) {
      expect(entry.minRamGb).toBeLessThanOrEqual(8);
      expect(entry.requiresAppleSilicon).toBe(false);
    }
  });

  it("surfaces compatible candidates that fit a 16GB Apple Silicon machine", () => {
    const fallback = compatibilityFallbackForHardware(midSpecApple);
    expect(fallback.length).toBeGreaterThanOrEqual(1);
    expect(fallback.length).toBeLessThanOrEqual(2);
    expect(fallback[0]?.capability).toBe("planner-llm");
    // Every candidate genuinely fits: enough RAM, and Apple-Silicon-only weights
    // are allowed here precisely because the machine IS Apple Silicon.
    for (const entry of fallback) {
      expect(entry.minRamGb).toBeLessThanOrEqual(16);
      // requiresAppleSilicon may be true (this machine has it) — never unfit.
    }
  });

  it("returns no fallback when a flagship already fits, or while hardware is unknown", () => {
    expect(hasFlagshipModelForHardware(highSpec)).toBe(true);
    expect(compatibilityFallbackForHardware(highSpec)).toEqual([]);
    // hw === null fits everything → no fallback noise during the load flicker.
    expect(compatibilityFallbackForHardware(null)).toEqual([]);
  });
});
