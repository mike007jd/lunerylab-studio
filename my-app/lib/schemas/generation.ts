import { z } from "zod";

export const assetDTOSchema = z.strictObject({
  id: z.string(),
  jobId: z.string(),
  projectId: z.string().nullable(),
  kind: z.enum(["REFERENCE", "GENERATED"]),
  origin: z.enum(["USER", "TEMPLATE"]),
  modality: z.enum(["IMAGE", "VIDEO", "MODEL_3D"]),
  mimeType: z.string(),
  byteSize: z.number().finite(),
  width: z.number().finite().nullable(),
  height: z.number().finite().nullable(),
  format: z.string().nullable(),
  durationSeconds: z.number().finite().nullable(),
  tags: z.array(z.string()),
  isFavorite: z.boolean(),
  note: z.string().nullable(),
  summary: z.string().nullable(),
  agentTaskId: z.string().nullable(),
  parentAssetId: z.string().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  url: z.string(),
  generationSeed: z.number().finite().nullable().optional(),
  generationSteps: z.number().finite().nullable().optional(),
  generationCfg: z.number().finite().nullable().optional(),
  negativePrompt: z.string().nullable().optional(),
  generationModel: z.string().nullable().optional(),
});

export const generationResponseSchema = z.strictObject({
  job: z.strictObject({
    id: z.string(),
    status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"]),
    requestedCount: z.number().int().nonnegative(),
    successCount: z.number().int().nonnegative(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    projectId: z.string().nullable(),
  }),
  assets: z.array(assetDTOSchema),
  warnings: z.array(z.string()),
});

export const videoCreateResponseSchema = z.strictObject({
  jobId: z.string().min(1),
  status: z.string(),
  duration: z.number().finite().nullable(),
  projectId: z.string().nullable(),
  warnings: z.array(z.string()).optional(),
});

export const videoStatusResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("RUNNING") }),
  z.strictObject({
    status: z.literal("SUCCEEDED"),
    asset: assetDTOSchema.nullable(),
  }),
  z.strictObject({
    status: z.literal("FAILED"),
    error: z.string(),
  }),
]);

export type AssetDTO = z.infer<typeof assetDTOSchema>;
export type GenerationResponse = z.infer<typeof generationResponseSchema>;
export type VideoStatusResponse = z.infer<typeof videoStatusResponseSchema>;
