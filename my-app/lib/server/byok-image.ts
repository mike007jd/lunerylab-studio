// BYOK image generation entrypoint. Reads the per-provider API key from the
// desktop keychain bridge, resolves the user-selected model id, and dispatches
// to provider-specific adapters.

import "server-only";
import { ApiError } from "@/lib/server/errors";
import type { ByokImageApiMode } from "@/lib/byok-providers";
import {
  isByokModelSelectionId,
  parseByokModelSelection,
} from "@/lib/server/byok-shared";
import { resolveByokProviderConfig } from "@/lib/server/byok-provider-config";
import type {
  GenerateImageInput,
  GenerateImageResult,
  GeneratedImage,
} from "@/lib/server/generation-types";
import {
  generateImagesFal,
  generateImagesOpenAiCompatible,
  generateImagesOpenAiEdit,
  generateImagesOpenAiRest,
  generateImagesReplicate,
  type ResolvedByokConfig,
} from "@/lib/server/byok-image-adapters";

type ImageGenerator = (
  config: ResolvedByokConfig,
  input: GenerateImageInput,
) => Promise<GeneratedImage[]>;

const IMAGE_GENERATORS = {
  "openai-rest": (config, input) =>
    input.isEdit
      ? generateImagesOpenAiEdit(config, input)
      : generateImagesOpenAiRest(config, input),
  replicate: generateImagesReplicate,
  fal: generateImagesFal,
  "openai-compatible": generateImagesOpenAiCompatible,
} satisfies Record<Exclude<ByokImageApiMode, "none">, ImageGenerator>;

function requireImageMode(meta: { label: string; imageApiMode: ByokImageApiMode }): Exclude<ByokImageApiMode, "none"> {
  if (meta.imageApiMode === "none") {
    throw new ApiError({
      status: 400,
      code: "byok_image_unsupported",
      message: `${meta.label} does not support image generation.`,
      retryable: false,
    });
  }
  return meta.imageApiMode;
}

function resolveModelId(input: GenerateImageInput, providerId: string): string | undefined {
  const fromInput = input.modelId?.trim();
  if (isByokModelSelectionId(fromInput)) {
    const selected = parseByokModelSelection(fromInput);
    if (selected?.providerId === providerId) return selected.modelId;
    return undefined;
  }
  if (fromInput) return fromInput;
  return undefined;
}

export async function generateImagesByok(
  input: GenerateImageInput,
  providerId: string,
): Promise<GenerateImageResult> {
  const resolved = await resolveByokProviderConfig({
    providerId,
    validateProvider(meta) {
      requireImageMode(meta);
      if (input.isEdit && !meta.capabilities.includes("image-edit")) {
        throw new ApiError({
          status: 400,
          code: "byok_image_unsupported",
          message: `${meta.label} BYOK does not support image edit.`,
          retryable: false,
        });
      }
    },
    resolveModelId: ({ connection }) =>
      resolveModelId(input, providerId) ??
      (input.isEdit
        ? connection?.models?.imageEdit ?? connection?.models?.imageGenerate
        : connection?.models?.imageGenerate),
    missingEndpointMessage: (meta) => `${meta.label} is missing an endpoint. Open Settings to configure.`,
    missingModelMessage: (meta) => `${meta.label} requires a model id. Open Settings to configure.`,
  });
  const meta = resolved.providerMeta;
  const imageMode = requireImageMode(meta);

  const config: ResolvedByokConfig = {
    apiKey: resolved.apiKey,
    endpoint: resolved.endpoint,
    modelId: resolved.modelId,
  };

  const images = await IMAGE_GENERATORS[imageMode](config, input);

  return {
    provider: `byok:${providerId}`,
    model: resolved.modelId,
    images,
    warnings: [],
  };
}
