import { describe, expect, it } from "vitest";
import {
  STUDIO_HISTORY_LIMIT,
  STUDIO_HISTORY_STORAGE_KEY,
  loadStudioHistoryEntries,
  prependStudioHistoryEntry,
  type GenerationEntry,
} from "@/components/studio/use-studio-generation-history";
import type { AssetDTO } from "@/lib/types/api";

function asset(overrides: Partial<AssetDTO> = {}): AssetDTO {
  return {
    id: "asset-1",
    jobId: "job-1",
    projectId: null,
    kind: "GENERATED",
    origin: "USER",
    modality: "IMAGE",
    mimeType: "image/png",
    byteSize: 123,
    width: 1024,
    height: 1024,
    format: "png",
    durationSeconds: null,
    tags: [],
    isFavorite: false,
    note: null,
    summary: null,
    agentTaskId: null,
    parentAssetId: null,
    deletedAt: null,
    createdAt: "2026-07-23T00:00:00.000Z",
    url: "/api/assets/asset-1/content",
    generationSeed: 7,
    ...overrides,
  };
}

function entry(overrides: Partial<GenerationEntry> = {}): GenerationEntry {
  return {
    id: "entry-1",
    mode: "image",
    status: "succeeded",
    prompt: "poster",
    modelId: "local-model",
    aspectRatio: "1:1",
    count: 1,
    presetId: null,
    projectId: null,
    referenceAssetIds: [],
    batchVariants: null,
    generationParameters: { seed: 7 },
    assets: [],
    warnings: [],
    error: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("Studio history current Lunery schema", () => {
  it("uses the current storage key", () => {
    expect(STUDIO_HISTORY_STORAGE_KEY).toBe("lunerylab:studio-history");
    expect(STUDIO_HISTORY_STORAGE_KEY).not.toContain("luna:studio-history");
  });

  it("round-trips a current payload and ignores malformed entries", () => {
    const valid = entry({
      id: "ok",
      generationParameters: { steps: 20, cfg: 4.5 },
      assets: [asset()],
    });
    const raw = JSON.stringify([
      valid,
      { id: "missing-params", mode: "image", status: "succeeded" },
      { ...valid, id: "bad-seed", generationParameters: { seed: 1.5 } },
      { ...valid, id: "null-asset", assets: [null] },
      { ...valid, id: "bad-asset-field", assets: [asset({ byteSize: NaN })] },
      null,
      "nope",
    ]);

    expect(loadStudioHistoryEntries(raw)).toEqual([valid]);
  });

  it("treats persisted running entries as interrupted", () => {
    const raw = JSON.stringify([entry({ id: "run", status: "running" })]);
    expect(loadStudioHistoryEntries(raw)).toEqual([
      entry({ id: "run", status: "interrupted" }),
    ]);
  });

  it("resets when the payload is not the current array schema", () => {
    expect(loadStudioHistoryEntries(JSON.stringify({ version: 1, entries: [] }))).toEqual([]);
    expect(loadStudioHistoryEntries("not-json")).toEqual([]);
  });

  it("keeps the strict runtime limit", () => {
    const existing = Array.from({ length: STUDIO_HISTORY_LIMIT }, (_, index) =>
      entry({ id: `existing-${index}` }),
    );
    const next = prependStudioHistoryEntry(existing, entry({ id: "newest" }));
    expect(next).toHaveLength(STUDIO_HISTORY_LIMIT);
    expect(next[0]?.id).toBe("newest");
  });
});
