// Image model metadata. UI consumers see a unified live catalog ordered
// local → BYOK; static cloud rows are intentionally not shipped because model
// names move quickly and this product must never expose an unverified runtime.
// The `id` field is the stable internal identifier persisted in
// UserSettings.defaultImageModel and GenerationJob rows. `providerModelId` is
// the provider/native model id used at call time.

export type ImageApiMode = "image" | "multimodal-text";
export type ModelTier = "fast" | "standard" | "premium";
export type ImageModelSource = "local" | "byok" | "cloud";

export interface ModelSourceEvidence {
  label: string;
  url: string;
  lastVerifiedAt: string;
}

export interface ImageModelEntry {
  id: string;
  providerModelId: string;
  apiMode: ImageApiMode;
  brand: string;
  brandZh: string;
  label: string;
  labelZh: string;
  tier: ModelTier;
  supportsEdit: boolean;
  supportsAspectRatio: boolean;
  defaultSize?: `${number}x${number}`;
  /** Where this model actually runs. Set explicitly by every catalog row. */
  source?: ImageModelSource;
  sourceEvidence?: ModelSourceEvidence[];
  freshnessExpiresAt?: string;
  freshnessNote?: string;
}

export const NO_DEFAULT_IMAGE_MODEL_ID = "";
