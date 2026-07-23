// Image model metadata. UI consumers see a unified live catalog ordered
// local → BYOK; static cloud rows are intentionally not shipped because model
// names move quickly and this product must never expose an unverified runtime.
// The `id` field is the stable internal identifier persisted in
// UserSettings.defaultImageModel and GenerationJob rows. `providerModelId` is
// the provider/native model id used at call time.

import { BYOK_PROVIDERS, type ByokImageApiMode } from "@/lib/byok-providers";
import type { GenerationParameters } from "@/lib/generation-parameters";

export type ImageApiMode = "image" | "multimodal-text";
export type ModelTier = "fast" | "standard" | "premium";
export type ImageModelSource = "local" | "byok" | "cloud";

export interface ModelSourceEvidence {
  label: string;
  url: string;
  lastVerifiedAt: string;
}

/** Per-field advanced diffusion controls. Catalogs and adapters share this contract. */
export interface ImageAdvancedParameterCapabilities {
  seed: boolean;
  steps: boolean;
  cfg: boolean;
  negativePrompt: boolean;
}

/** Officially verified advanced-parameter contract for one exact BYOK model. */
export interface VerifiedImageAdvancedParameterRecord {
  imageApiMode: "replicate" | "fal";
  modelId: string;
  sourceUrl: string;
  checkedAt: "2026-07-23";
  capabilities: ImageAdvancedParameterCapabilities;
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
  /**
   * Explicit advanced-parameter contract for this row. When omitted, callers
   * must resolve via {@link resolveImageAdvancedParameters} (unknown → none).
   */
  advancedParameters?: ImageAdvancedParameterCapabilities;
}

export const NO_DEFAULT_IMAGE_MODEL_ID = "";

export const NO_ADVANCED_IMAGE_PARAMETERS: ImageAdvancedParameterCapabilities = {
  seed: false,
  steps: false,
  cfg: false,
  negativePrompt: false,
};

export const ALL_ADVANCED_IMAGE_PARAMETERS: ImageAdvancedParameterCapabilities = {
  seed: true,
  steps: true,
  cfg: true,
  negativePrompt: true,
};

const BYOK_ID_PATTERN = /^byok:([^:]+):(.+)$/;

export const VERIFIED_IMAGE_ADVANCED_PARAMETER_RECORDS: readonly VerifiedImageAdvancedParameterRecord[] = [
  {
    imageApiMode: "replicate",
    modelId: "black-forest-labs/flux-2-pro",
    sourceUrl: "https://replicate.com/black-forest-labs/flux-2-pro/api/schema",
    checkedAt: "2026-07-23",
    capabilities: { seed: true, steps: false, cfg: false, negativePrompt: false },
  },
  {
    imageApiMode: "fal",
    modelId: "fal-ai/flux-pro/v1.1",
    sourceUrl: "https://fal.ai/models/fal-ai/flux-pro/v1.1/api",
    checkedAt: "2026-07-23",
    capabilities: { seed: true, steps: false, cfg: false, negativePrompt: false },
  },
  {
    imageApiMode: "fal",
    modelId: "fal-ai/flux-pro/v1/fill",
    sourceUrl: "https://fal.ai/models/fal-ai/flux-pro/v1/fill/api",
    checkedAt: "2026-07-23",
    capabilities: { seed: true, steps: false, cfg: false, negativePrompt: false },
  },
  {
    imageApiMode: "fal",
    modelId: "fal-ai/flux-pulid",
    sourceUrl: "https://fal.ai/models/fal-ai/flux-pulid/api",
    checkedAt: "2026-07-23",
    capabilities: ALL_ADVANCED_IMAGE_PARAMETERS,
  },
];

/** Find provenance and capabilities for an exact provider/model pair. */
export function findVerifiedImageAdvancedParameterRecord(
  imageApiMode: ByokImageApiMode | string | undefined,
  providerModelId: string,
): VerifiedImageAdvancedParameterRecord | undefined {
  if (imageApiMode !== "replicate" && imageApiMode !== "fal") return undefined;
  return VERIFIED_IMAGE_ADVANCED_PARAMETER_RECORDS.find(
    (record) =>
      record.imageApiMode === imageApiMode && record.modelId === providerModelId,
  );
}

/** Local runnable image models expose the full advanced-parameter set. */
export function localImageAdvancedParameters(): ImageAdvancedParameterCapabilities {
  return ALL_ADVANCED_IMAGE_PARAMETERS;
}

/**
 * BYOK advanced-parameter capabilities from exact, verified provider/model
 * records shared by catalogs and adapters. Unknown models → none.
 */
export function byokImageAdvancedParameters(
  imageApiMode: ByokImageApiMode | string | undefined,
  providerModelId: string,
): ImageAdvancedParameterCapabilities {
  return (
    findVerifiedImageAdvancedParameterRecord(imageApiMode, providerModelId)?.capabilities ??
    NO_ADVANCED_IMAGE_PARAMETERS
  );
}

export function supportsAnyAdvancedImageParameter(
  capabilities: ImageAdvancedParameterCapabilities,
): boolean {
  return (
    capabilities.seed ||
    capabilities.steps ||
    capabilities.cfg ||
    capabilities.negativePrompt
  );
}

export function filterGenerationParametersToCapabilities(
  parameters: GenerationParameters,
  capabilities: ImageAdvancedParameterCapabilities,
): GenerationParameters {
  const filtered: GenerationParameters = {};
  if (capabilities.seed && parameters.seed !== undefined) filtered.seed = parameters.seed;
  if (capabilities.steps && parameters.steps !== undefined) filtered.steps = parameters.steps;
  if (capabilities.cfg && parameters.cfg !== undefined) filtered.cfg = parameters.cfg;
  if (capabilities.negativePrompt && parameters.negativePrompt) {
    filtered.negativePrompt = parameters.negativePrompt;
  }
  return filtered;
}

/**
 * Resolve the effective advanced-parameter contract for a catalog row.
 * Prefer an explicit stamp; otherwise derive from source / BYOK id.
 * Unknown BYOK defaults to no advanced fields.
 */
export function resolveImageAdvancedParameters(
  model:
    | Pick<ImageModelEntry, "id" | "providerModelId" | "source" | "advancedParameters">
    | null
    | undefined,
): ImageAdvancedParameterCapabilities {
  if (!model) return NO_ADVANCED_IMAGE_PARAMETERS;
  if (model.advancedParameters) return model.advancedParameters;
  if (model.source === "local") return localImageAdvancedParameters();

  const match = BYOK_ID_PATTERN.exec(model.id);
  if (match) {
    const provider = BYOK_PROVIDERS.find((entry) => entry.id === match[1]);
    return byokImageAdvancedParameters(provider?.imageApiMode, model.providerModelId);
  }

  if (model.source === "byok") {
    return NO_ADVANCED_IMAGE_PARAMETERS;
  }

  return NO_ADVANCED_IMAGE_PARAMETERS;
}
