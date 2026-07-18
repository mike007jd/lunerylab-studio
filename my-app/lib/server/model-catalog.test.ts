import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getLocalImageModels: vi.fn(),
  resolveLocalImageModelEntry: vi.fn(),
  getByokImageModels: vi.fn(),
  getByokVideoModels: vi.fn(),
  resolveLocalImageRuntimeAvailability: vi.fn(),
}));

vi.mock("@/lib/server/local-image-model-catalog", () => ({
  getLocalImageModels: mocks.getLocalImageModels,
  resolveLocalImageModelEntry: mocks.resolveLocalImageModelEntry,
}));

vi.mock("@/lib/server/byok-image-catalog", () => ({
  getByokImageModels: mocks.getByokImageModels,
  getByokVideoModels: mocks.getByokVideoModels,
}));

vi.mock("@/lib/server/runtime-supply", () => ({
  resolveLocalImageRuntimeAvailability: mocks.resolveLocalImageRuntimeAvailability,
}));

import { getModelCatalog, resolveImageModelEntry } from "@/lib/server/model-catalog";

describe("getModelCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLocalImageModels.mockResolvedValue([]);
    mocks.getByokImageModels.mockResolvedValue([]);
    mocks.getByokVideoModels.mockResolvedValue([]);
    mocks.resolveLocalImageRuntimeAvailability.mockResolvedValue({
      sdCpp: false,
      comfyUi: false,
    });
  });

  it("filters installed local models through current runtime availability", async () => {
    await getModelCatalog();

    expect(mocks.resolveLocalImageRuntimeAvailability).toHaveBeenCalledOnce();
    expect(mocks.getLocalImageModels).toHaveBeenCalledWith({
      sdCpp: false,
      comfyUi: false,
    });
  });

  it("applies the same runtime availability when resolving a selected local model", async () => {
    mocks.resolveLocalImageModelEntry.mockResolvedValue(undefined);

    await expect(resolveImageModelEntry("offline-local-model")).resolves.toBeUndefined();

    expect(mocks.resolveLocalImageModelEntry).toHaveBeenCalledWith("offline-local-model", {
      sdCpp: false,
      comfyUi: false,
    });
  });
});
