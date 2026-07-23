// Provider-specific BYOK image adapters. The entrypoint in `byok-image.ts`
// owns key/model resolution; this file only translates a resolved provider
// config into that provider's API shape.

import "server-only";
import sharp from "sharp";
import {
  generateImage,
  type DataContent,
  type GeneratedFile as AiGeneratedFile,
  type ImageModel,
} from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ApiError } from "@/lib/server/errors";
import { isOpenAiGptImageModel } from "@/lib/byok-providers";
import {
  aspectRatioToSize,
  bufferToDataUrl,
  downloadImageFromUrl,
  sniffImageMime,
  withTimeoutSignal,
} from "@/lib/server/byok-shared";
import {
  falQueueResult,
  runReplicatePrediction,
} from "@/lib/server/byok-provider-clients";
import type { GenerateImageInput, GeneratedImage } from "@/lib/server/generation-types";
import { normalizeGenerationParameters } from "@/lib/generation-parameters";
import {
  byokImageAdvancedParameters,
  filterGenerationParametersToCapabilities,
} from "@/lib/image-models";

export interface ResolvedByokConfig {
  apiKey: string;
  endpoint: string;
  modelId: string;
}

/**
 * Vendor reference-image limits cluster around 8 MB per image (base64
 * inflation pushes that to ~10.6 MB on the wire). Anything bigger gets
 * rejected by Replicate / Fal with a confusing 413; pre-compress with sharp.
 */
const MAX_REF_BYTES = 8 * 1024 * 1024;
const MAX_REF_DIMENSION = 1536;
const MAX_REFS_PER_REQUEST = 4;

async function compressReferenceBuffer(buffer: Buffer): Promise<Buffer> {
  if (buffer.byteLength <= MAX_REF_BYTES) return buffer;
  const resizeOptions = {
    width: MAX_REF_DIMENSION,
    height: MAX_REF_DIMENSION,
    fit: "inside" as const,
    withoutEnlargement: true,
  };
  // Preserve PNG for mask-like inputs (FLUX-Fill / inpaint flows pass the
  // mask as references[1]). JPEG re-encoding softens mask edges → inpaint
  // bleed or 422s from strict schemas. Try PNG first; only fall through to
  // JPEG when palette+downscale still can't get under MAX_REF_BYTES.
  if (sniffImageMime(buffer) === "image/png") {
    const png = await sharp(buffer)
      .rotate()
      .resize(resizeOptions)
      .png({ compressionLevel: 9 })
      .toBuffer();
    if (png.byteLength <= MAX_REF_BYTES) return png;
  }
  // `fit: inside` preserves aspect; no upscale. JPEG quality 88 is high enough
  // for vision-conditioning while keeping size under ~6 MB at 1536px long edge.
  return sharp(buffer)
    .rotate()
    .resize(resizeOptions)
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

async function prepareReferenceDataUrls(input: GenerateImageInput): Promise<string[]> {
  const refs = input.references ?? [];
  if (refs.length === 0) return [];
  const trimmed = refs.slice(0, MAX_REFS_PER_REQUEST);
  return Promise.all(
    trimmed.map(async (buf) => {
      const compressed = await compressReferenceBuffer(buf);
      return bufferToDataUrl(compressed, sniffImageMime(compressed) ?? "image/png");
    }),
  );
}

/**
 * Build the reference-image fragment of a provider body — but only with the
 * field names the provider's schema actually expects. Stuffing every variant
 * (image / image_url / input_image / images / image_urls) at once is what
 * tripped strict schemas (FLUX-Fill, Hunyuan) into 422s.
 */
function buildReferencePayload(
  apiMode: "replicate" | "fal",
  modelId: string,
  dataUrls: string[],
): Record<string, unknown> {
  if (dataUrls.length === 0) return {};
  const first = dataUrls[0];
  const id = modelId.toLowerCase();

  if (apiMode === "replicate") {
    // Replicate model schemas vary. Heuristics — keyed on common BFL / SD
    // model id substrings; if the user picked a custom model we send the
    // most-common pair (image + image_url) only.
    if (id.includes("flux-fill") || id.includes("inpaint")) {
      // mask-conditioned models need both an image and (typically) a mask.
      // We don't synthesize a mask here; the caller passes references in
      // [image, mask, ...] order when an edit operation requires it.
      return dataUrls.length > 1
        ? { image: first, mask: dataUrls[1] }
        : { image: first };
    }
    if (id.includes("flux") || id.includes("schnell") || id.includes("sdxl") || id.includes("ip-adapter")) {
      return { image: first };
    }
    if (id.includes("image-to-image") || id.includes("img2img")) {
      return { image: first };
    }
    // Sensible default for most Replicate text-to-image models that accept an
    // optional reference for img2img-style conditioning.
    return { image: first, image_url: first };
  }

  // fal — almost universally uses image_url (single) or image_urls (array).
  if (id.includes("flux-fill") || id.includes("inpaint")) {
    return dataUrls.length > 1
      ? { image_url: first, mask_url: dataUrls[1] }
      : { image_url: first };
  }
  return dataUrls.length > 1
    ? { image_url: first, image_urls: dataUrls }
    : { image_url: first };
}

function classifyHttpError(status: number, providerLabel: string, body: string): ApiError {
  const truncated = body ? body.slice(0, 300) : "";
  if (status === 401 || status === 403) {
    return new ApiError({
      status: 503,
      code: "missing_api_key",
      message: `${providerLabel} rejected the API key.`,
      retryable: false,
    });
  }
  if (status === 429) {
    return new ApiError({
      status: 429,
      code: "quota_exceeded",
      message: `${providerLabel} is rate limiting requests. ${truncated}`.trim(),
      retryable: false,
    });
  }
  if (status >= 500) {
    return new ApiError({
      status: 502,
      code: "provider_error",
      message: `${providerLabel} is temporarily unavailable.`,
      retryable: true,
    });
  }
  return new ApiError({
    status: 400,
    code: "invalid_argument",
    message: `${providerLabel} rejected the request. ${truncated}`.trim(),
    retryable: false,
  });
}

// downloadImageFromUrl lives in `byok-shared.ts`.

async function prepareReferenceImageData(input: GenerateImageInput): Promise<DataContent[]> {
  const refs = input.references ?? [];
  if (refs.length === 0) return [];
  const trimmed = refs.slice(0, MAX_REFS_PER_REQUEST);
  return Promise.all(trimmed.map((buffer) => compressReferenceBuffer(buffer)));
}

function generatedFilesToImages(files: readonly AiGeneratedFile[], emptyMessage: string): GeneratedImage[] {
  if (files.length === 0) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: emptyMessage,
      retryable: true,
    });
  }
  return files.map((image) => ({
    bytes: Buffer.from(image.uint8Array),
    mimeType: image.mediaType || "image/png",
  }));
}

function classifySdkImageError(error: unknown, providerLabel: string): ApiError {
  if (error instanceof ApiError) return error;
  const maybe = error as {
    statusCode?: number;
    status?: number;
    responseBody?: string;
    body?: string;
    message?: string;
    name?: string;
  } | null;
  if (maybe?.name === "AbortError" || maybe?.name === "TimeoutError") {
    return new ApiError({
      status: 504,
      code: "provider_timeout",
      message: `${providerLabel} image request timed out.`,
      retryable: true,
    });
  }
  const status =
    typeof maybe?.statusCode === "number"
      ? maybe.statusCode
      : typeof maybe?.status === "number"
        ? maybe.status
        : undefined;
  if (status) {
    return classifyHttpError(status, providerLabel, maybe?.responseBody ?? maybe?.body ?? maybe?.message ?? "");
  }
  return new ApiError({
    status: 502,
    code: "provider_error",
    message: `${providerLabel} image request failed. ${maybe?.message?.slice(0, 200) ?? ""}`.trim(),
    retryable: true,
  });
}

async function generateImagesWithAiSdk({
  label,
  model,
  input,
  providerOptions,
}: {
  label: string;
  model: ImageModel;
  input: GenerateImageInput;
  providerOptions?: ProviderOptions;
}): Promise<GeneratedImage[]> {
  const requested = Math.max(1, input.count || 1);
  const { size } = aspectRatioToSize(input.aspectRatio);
  const prompt =
    input.isEdit
      ? {
          text: input.prompt,
          images: await prepareReferenceImageData(input),
        }
      : input.prompt;

  if (input.isEdit && typeof prompt !== "string" && prompt.images.length === 0) {
    throw new ApiError({
      status: 400,
      code: "invalid_request",
      message: `${label} image editing requires at least one reference image.`,
      retryable: false,
    });
  }

  try {
    const result = await generateImage({
      model,
      prompt,
      n: requested,
      size,
      providerOptions,
      abortSignal: withTimeoutSignal(input.abortSignal, 120_000),
    });
    return generatedFilesToImages(result.images, `${label} returned no images.`);
  } catch (error) {
    throw classifySdkImageError(error, label);
  }
}

// ---------------------------------------------------------------------------
// OpenAI image generation via AI SDK imageModel
// ---------------------------------------------------------------------------

export async function generateImagesOpenAiRest(
  config: ResolvedByokConfig,
  input: GenerateImageInput,
): Promise<GeneratedImage[]> {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.endpoint,
  });
  return generateImagesWithAiSdk({
    label: "OpenAI",
    model: provider.imageModel(config.modelId as never) as ImageModel,
    input,
  });
}

// ---------------------------------------------------------------------------
// OpenAI image edit via AI SDK imageModel
// ---------------------------------------------------------------------------

export async function generateImagesOpenAiEdit(
  config: ResolvedByokConfig,
  input: GenerateImageInput,
): Promise<GeneratedImage[]> {
  if (!isOpenAiGptImageModel(config.modelId)) {
    throw new ApiError({
      status: 400,
      code: "model_edit_unsupported",
      message: "OpenAI image editing requires an explicit GPT Image model id.",
      retryable: false,
    });
  }
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.endpoint,
  });
  return generateImagesWithAiSdk({
    label: "OpenAI",
    model: provider.imageModel(config.modelId as never) as ImageModel,
    input: { ...input, isEdit: true },
  });
}

// ---------------------------------------------------------------------------
// Replicate — POST /v1/predictions + polling
// ---------------------------------------------------------------------------

export async function generateImagesReplicate(
  config: ResolvedByokConfig,
  input: GenerateImageInput,
): Promise<GeneratedImage[]> {
  const apiBase = config.endpoint.replace(/\/+$/, "");
  const requested = Math.max(1, input.count || 1);
  const { width, height } = aspectRatioToSize(input.aspectRatio);

  const refUrls = await prepareReferenceDataUrls(input);
  const capabilities = byokImageAdvancedParameters("replicate", config.modelId);
  const requestedParameters = filterGenerationParametersToCapabilities(
    normalizeGenerationParameters(input.generationParameters ?? {}),
    capabilities,
  );
  const parameterInput = {
    ...(requestedParameters.seed === undefined ? {} : { seed: requestedParameters.seed }),
    ...(requestedParameters.steps === undefined ? {} : { num_inference_steps: requestedParameters.steps }),
    ...(requestedParameters.cfg === undefined ? {} : { guidance_scale: requestedParameters.cfg }),
    ...(requestedParameters.negativePrompt ? { negative_prompt: requestedParameters.negativePrompt } : {}),
  };
  const prediction = await runReplicatePrediction({
    apiKey: config.apiKey,
    apiBase,
    modelId: config.modelId,
    input: {
      prompt: input.prompt,
      width,
      height,
      num_outputs: requested,
      ...parameterInput,
      ...buildReferencePayload("replicate", config.modelId, refUrls),
    },
    deadlineMs: 4.5 * 60_000,
    intervalMs: 1500,
    label: "Replicate prediction",
    classifyHttpError: (status, body) => classifyHttpError(status, "Replicate", body),
    abortSignal: input.abortSignal,
  });

  const outputs = Array.isArray(prediction.output)
    ? (prediction.output as unknown[])
    : prediction.output
      ? [prediction.output]
      : [];
  const urls = outputs.filter((value): value is string => typeof value === "string");
  if (urls.length === 0) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: "Replicate prediction returned no image URLs.",
      retryable: true,
    });
  }
  const images = await Promise.all(urls.map((url) => downloadImageFromUrl(url)));
  if (!capabilities.seed && !capabilities.steps && !capabilities.cfg && !capabilities.negativePrompt) {
    return images;
  }
  return images.map((image) => ({
    ...image,
    generationParameters: {
      seed: requestedParameters.seed ?? null,
      steps: requestedParameters.steps ?? null,
      cfg: requestedParameters.cfg ?? null,
      negativePrompt: requestedParameters.negativePrompt ?? null,
      modelId: config.modelId,
    },
  }));
}

// ---------------------------------------------------------------------------
// Fal — POST queue.fal.run/{modelId} + polling
// ---------------------------------------------------------------------------

interface FalImagesPayload {
  images?: Array<{ url?: string; content_type?: string }>;
  image?: { url?: string; content_type?: string };
  seed?: number;
}

export async function generateImagesFal(
  config: ResolvedByokConfig,
  input: GenerateImageInput,
): Promise<GeneratedImage[]> {
  const apiBase = config.endpoint.replace(/\/+$/, "");
  const requested = Math.max(1, input.count || 1);
  const { width, height } = aspectRatioToSize(input.aspectRatio);

  const refUrls = await prepareReferenceDataUrls(input);
  const capabilities = byokImageAdvancedParameters("fal", config.modelId);
  const requestedParameters = filterGenerationParametersToCapabilities(
    normalizeGenerationParameters(input.generationParameters ?? {}),
    capabilities,
  );
  const body = {
    prompt: input.prompt,
    image_size: { width, height },
    num_images: requested,
    ...(requestedParameters.seed !== undefined ? { seed: requestedParameters.seed } : {}),
    ...(requestedParameters.steps !== undefined ? { num_inference_steps: requestedParameters.steps } : {}),
    ...(requestedParameters.cfg !== undefined ? { guidance_scale: requestedParameters.cfg } : {}),
    ...(requestedParameters.negativePrompt ? { negative_prompt: requestedParameters.negativePrompt } : {}),
    ...buildReferencePayload("fal", config.modelId, refUrls),
  };

  const payload = await falQueueResult<FalImagesPayload>({
    apiKey: config.apiKey,
    apiBase,
    modelPath: config.modelId,
    body,
    deadlineMs: 4.5 * 60_000,
    label: "Fal image",
    abortSignal: input.abortSignal,
  });
  const images = await extractFalImages(payload, "Fal");
  if (!capabilities.seed && !capabilities.steps && !capabilities.cfg && !capabilities.negativePrompt) {
    return images;
  }
  return images.map((image) => ({
    ...image,
    generationParameters: {
      seed: typeof payload.seed === "number" ? payload.seed : requestedParameters.seed ?? null,
      steps: requestedParameters.steps ?? null,
      cfg: requestedParameters.cfg ?? null,
      negativePrompt: capabilities.negativePrompt ? requestedParameters.negativePrompt ?? null : null,
      modelId: config.modelId,
    },
  }));
}

async function extractFalImages(
  payload: FalImagesPayload,
  providerLabel: string,
): Promise<GeneratedImage[]> {
  const items = payload.images ?? (payload.image ? [payload.image] : []);
  const urls = items
    .map((item) => item?.url)
    .filter((url): url is string => typeof url === "string" && url.length > 0);
  if (urls.length === 0) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `${providerLabel} returned no images.`,
      retryable: true,
    });
  }
  return Promise.all(urls.map((url) => downloadImageFromUrl(url)));
}

// ---------------------------------------------------------------------------
// OpenAI-compatible image generation via AI SDK imageModel
// (Together, Fireworks, custom OpenAI-compatible servers)
// ---------------------------------------------------------------------------

export async function generateImagesOpenAiCompatible(
  config: ResolvedByokConfig,
  input: GenerateImageInput,
): Promise<GeneratedImage[]> {
  const apiBase = config.endpoint.replace(/\/+$/, "");
  const { width, height } = aspectRatioToSize(input.aspectRatio);
  const provider = createOpenAICompatible({
    name: "openai-compatible",
    baseURL: apiBase,
    apiKey: config.apiKey,
  });
  return generateImagesWithAiSdk({
    label: "Image provider",
    model: provider.imageModel(config.modelId) as ImageModel,
    input,
    providerOptions: {
      "openai-compatible": { width, height },
    },
  });
}
