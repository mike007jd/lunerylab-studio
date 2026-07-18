export const GENERATION_PARAMETER_LIMITS = {
  seed: { min: 0, max: 2_147_483_647 },
  steps: { min: 1, max: 150 },
  cfg: { min: 0, max: 30 },
  negativePromptMaxLength: 2_000,
} as const;

export interface GenerationParameters {
  seed?: number;
  steps?: number;
  cfg?: number;
  negativePrompt?: string;
}

export interface AppliedGenerationParameters {
  seed: number | null;
  steps: number | null;
  cfg: number | null;
  negativePrompt: string | null;
  modelId: string;
}

export function randomGenerationSeed(): number {
  return Math.floor(Math.random() * (GENERATION_PARAMETER_LIMITS.seed.max + 1));
}

export function normalizeGenerationParameters(input: GenerationParameters): GenerationParameters {
  const normalized: GenerationParameters = {};
  if (Number.isInteger(input.seed)) {
    normalized.seed = Math.max(GENERATION_PARAMETER_LIMITS.seed.min, Math.min(GENERATION_PARAMETER_LIMITS.seed.max, input.seed!));
  }
  if (Number.isInteger(input.steps)) {
    normalized.steps = Math.max(GENERATION_PARAMETER_LIMITS.steps.min, Math.min(GENERATION_PARAMETER_LIMITS.steps.max, input.steps!));
  }
  if (Number.isFinite(input.cfg)) {
    normalized.cfg = Math.max(GENERATION_PARAMETER_LIMITS.cfg.min, Math.min(GENERATION_PARAMETER_LIMITS.cfg.max, input.cfg!));
  }
  const negativePrompt = input.negativePrompt?.trim().slice(0, GENERATION_PARAMETER_LIMITS.negativePromptMaxLength);
  if (negativePrompt) normalized.negativePrompt = negativePrompt;
  return normalized;
}

export function generationAssetProvenance(
  parameters: AppliedGenerationParameters | undefined,
  fallbackModelId: string,
) {
  return {
    generationSeed: parameters?.seed ?? undefined,
    generationSteps: parameters?.steps ?? undefined,
    generationCfg: parameters?.cfg ?? undefined,
    negativePrompt: parameters?.negativePrompt ?? undefined,
    generationModel: parameters?.modelId ?? fallbackModelId,
  };
}
