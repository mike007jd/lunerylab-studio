import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  readImportedModels: vi.fn(),
  catalogModelInstalled: vi.fn(),
  modelFileExists: vi.fn(),
}));

vi.mock("@/lib/hf-model-catalog", () => ({
  HF_MODEL_CATALOG: [
    {
      id: "catalog-sd-model",
      sourceUrl: "https://huggingface.co/example/catalog-sd-model",
      checkedAt: "2026-07-23",
      label: "Catalog SD Model",
      capability: "image-gen",
      runtimeTarget: "sd-cpp",
      fileName: "model.safetensors",
      speedTier: "fast",
      sourceEvidence: [],
      freshnessExpiresAt: "2026-12-31",
      freshnessNote: "test",
    },
  ],
}));

vi.mock("@/lib/server/imported-model-registry", () => ({
  readImportedModels: mocks.readImportedModels,
}));

vi.mock("@/lib/server/local-model-files", () => ({
  catalogModelInstalled: mocks.catalogModelInstalled,
  modelFileExists: mocks.modelFileExists,
}));

import {
  getLocalImageModels,
  resolveLocalImageModelEntry,
} from "@/lib/server/local-image-model-catalog";

describe("local image model catalog runtime availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.catalogModelInstalled.mockResolvedValue(true);
    mocks.modelFileExists.mockResolvedValue({ exists: true, path: "/tmp/model.safetensors" });
    mocks.readImportedModels.mockResolvedValue([
      {
        id: "imported-comfyui-model",
        label: "Imported ComfyUI Model",
        capability: "image-gen",
        runtimeTarget: "comfyui",
        modelPath: "/tmp/comfyui.safetensors",
        source: "local-file",
        createdAt: "2026-07-13T00:00:00.000Z",
      },
    ]);
  });

  it("does not expose installed models whose required runtime is unavailable", async () => {
    const availability = { sdCpp: false, comfyUi: false };

    await expect(getLocalImageModels(availability)).resolves.toEqual([]);
    await expect(resolveLocalImageModelEntry("catalog-sd-model", availability)).resolves.toBeUndefined();
    await expect(resolveLocalImageModelEntry("imported-comfyui-model", availability)).resolves.toBeUndefined();
  });
});
