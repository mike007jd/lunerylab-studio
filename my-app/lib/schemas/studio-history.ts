import { z } from "zod";
import { assetDTOSchema } from "@/lib/schemas/generation";

export const generationParametersSchema = z.strictObject({
  seed: z.number().int().optional(),
  steps: z.number().int().optional(),
  cfg: z.number().finite().optional(),
  negativePrompt: z.string().min(1).optional(),
});

export const generationBatchVariantSchema = z.strictObject({
  key: z.string(),
  label: z.string(),
  promptSuffix: z.string(),
});

export const generationEntryStatusSchema = z.enum([
  "running",
  "succeeded",
  "partial",
  "failed",
  "canceled",
  "interrupted",
]);

export const generationEntrySchema = z.strictObject({
  id: z.string().min(1),
  mode: z.enum(["image", "video"]),
  status: generationEntryStatusSchema,
  prompt: z.string(),
  modelId: z.string(),
  aspectRatio: z.string(),
  count: z.number().int().positive(),
  presetId: z.string().nullable(),
  projectId: z.string().nullable(),
  referenceAssetIds: z.array(z.string()),
  batchVariants: z.array(generationBatchVariantSchema).nullable(),
  generationParameters: generationParametersSchema,
  videoDuration: z.number().int().positive().nullable(),
  assets: z.array(assetDTOSchema),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  createdAt: z.number().finite(),
});

export type GenerationEntry = z.infer<typeof generationEntrySchema>;
export type GenerationEntryStatus = z.infer<typeof generationEntryStatusSchema>;
export type GenerationMode = GenerationEntry["mode"];
export type GenerationBatchVariant = z.infer<typeof generationBatchVariantSchema>;
