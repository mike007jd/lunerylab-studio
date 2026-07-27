import { describe, expect, it } from "vitest";
import {
  assetDTOSchema,
  generationResponseSchema,
} from "@/lib/schemas/generation";
import { generationEntrySchema } from "@/lib/schemas/studio-history";

const asset = {
  id: "asset-1",
  jobId: "job-1",
  projectId: null,
  kind: "GENERATED" as const,
  origin: "USER" as const,
  modality: "IMAGE" as const,
  mimeType: "image/png",
  byteSize: 128,
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
  createdAt: "2026-07-27T00:00:00.000Z",
  url: "/api/assets/asset-1/content",
};

const entry = {
  id: "entry-1",
  mode: "image" as const,
  status: "succeeded" as const,
  prompt: "moonlit observatory",
  modelId: "local/test",
  aspectRatio: "1:1",
  count: 1,
  presetId: null,
  projectId: null,
  referenceAssetIds: [],
  batchVariants: null,
  generationParameters: {},
  videoDuration: null,
  assets: [asset],
  warnings: [],
  error: null,
  createdAt: 1,
};

describe("shared persisted generation schemas", () => {
  it("parses one asset shape for API responses and local history", () => {
    expect(assetDTOSchema.parse(asset)).toEqual(asset);
    expect(
      generationResponseSchema.parse({
        job: {
          id: "job-1",
          status: "SUCCEEDED",
          requestedCount: 1,
          successCount: 1,
          errorCode: null,
          errorMessage: null,
          projectId: null,
        },
        assets: [asset],
        warnings: [],
      }).assets[0],
    ).toEqual(asset);
    expect(generationEntrySchema.parse(entry).assets[0]).toEqual(asset);
  });

  it("accepts the current terminal job null error fields", () => {
    const result = generationResponseSchema.parse({
      job: {
        id: "job-1",
        status: "SUCCEEDED",
        requestedCount: 1,
        successCount: 1,
        errorCode: null,
        errorMessage: null,
        projectId: null,
      },
      assets: [asset],
      warnings: [],
    });

    expect(result.job.errorCode).toBeNull();
    expect(result.job.errorMessage).toBeNull();
  });

  it("rejects stale prelaunch history instead of migrating or guessing defaults", () => {
    const legacyEntry = { ...entry } as Partial<typeof entry>;
    delete legacyEntry.videoDuration;
    expect(generationEntrySchema.safeParse(legacyEntry).success).toBe(false);
  });

  it("rejects unknown persisted fields", () => {
    expect(
      generationEntrySchema.safeParse({ ...entry, legacyRunToken: "old" }).success,
    ).toBe(false);
  });
});
