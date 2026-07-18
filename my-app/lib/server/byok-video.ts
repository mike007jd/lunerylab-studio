/**
 * BYOK video generation core. Mirrors `byok-image.ts` for the video lane:
 * resolves the provider key + endpoint, picks an implementation by the
 * provider's `videoApiMode`, and returns video bytes ready for storage.
 *
 * Supported dispatch modes:
 *   - "fal"       → fal.queue path (sync or polled)
 *   - "replicate" → /v1/predictions + polling
 *   - "minimax"   → MiniMax video-generation REST
 *
 * SECURITY: the API key never leaves this module.
 */

import "server-only";
import { ApiError } from "@/lib/server/errors";
import type { ByokVideoApiMode } from "@/lib/byok-providers";
import {
  bufferToDataUrl,
  downloadRemoteBytes,
  pollUntil,
  withTimeoutSignal,
} from "@/lib/server/byok-shared";
import {
  falQueueSubmit,
  runReplicatePrediction,
} from "@/lib/server/byok-provider-clients";
import { resolveByokProviderConfig } from "@/lib/server/byok-provider-config";

export interface GenerateVideoByokInput {
  prompt: string;
  modelId?: string;
  durationSeconds: number;
  aspectRatio?: string;
  referenceImage?: Buffer;
  /** Caller cancel signal, merged with each request's internal timeout. */
  abortSignal?: AbortSignal;
}

export interface GenerateVideoByokResult {
  provider: string;
  model: string;
  video: { bytes: Buffer; mimeType: string };
}

interface ResolvedByokVideoConfig {
  providerId: string;
  apiKey: string;
  endpoint: string;
  modelId: string;
}

type VideoGenerator = (
  config: ResolvedByokVideoConfig,
  input: GenerateVideoByokInput,
) => Promise<{ bytes: Buffer; mimeType: string }>;

async function downloadVideo(url: string): Promise<{ bytes: Buffer; mimeType: string }> {
  return downloadRemoteBytes(url, {
    maxBytes: 768 * 1024 * 1024,
    timeoutMs: 120_000,
    fallbackMimeType: "video/mp4",
    label: "Generated video URL",
  });
}

// ---------------------------------------------------------------------------
// fal — queue + poll (shared client lives in byok-shared.falQueueSubmit)
// ---------------------------------------------------------------------------

interface FalVideoPayload {
  video?: { url?: string; content_type?: string };
  videos?: Array<{ url?: string }>;
}

async function generateVideoFal(
  config: ResolvedByokVideoConfig,
  input: GenerateVideoByokInput,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    duration: input.durationSeconds,
    aspect_ratio: input.aspectRatio,
  };
  if (input.referenceImage) {
    body.image_url = bufferToDataUrl(input.referenceImage);
  }
  // Video can be slow — poll up to 10 minutes.
  const url = await falQueueSubmit<FalVideoPayload>({
    apiKey: config.apiKey,
    apiBase: config.endpoint,
    modelPath: config.modelId,
    body,
    extractUrl: (p) => p.video?.url ?? p.videos?.[0]?.url,
    deadlineMs: 10 * 60_000,
    label: "Fal video",
    abortSignal: input.abortSignal,
  });
  return downloadVideo(url);
}

// ---------------------------------------------------------------------------
// Replicate — predictions + poll (re-uses image polling shape)
// ---------------------------------------------------------------------------

async function generateVideoReplicate(
  config: ResolvedByokVideoConfig,
  input: GenerateVideoByokInput,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const apiBase = config.endpoint.replace(/\/+$/, "");
  const prediction = await runReplicatePrediction({
    apiKey: config.apiKey,
    apiBase,
    modelId: config.modelId,
    label: "Replicate video",
    deadlineMs: 10 * 60_000,
    input: {
      prompt: input.prompt,
      duration: input.durationSeconds,
      aspect_ratio: input.aspectRatio,
      ...(input.referenceImage ? { image: bufferToDataUrl(input.referenceImage) } : {}),
    },
    abortSignal: input.abortSignal,
  });
  const output = Array.isArray(prediction.output) ? prediction.output : [prediction.output];
  const url = output.find((v): v is string => typeof v === "string");
  if (!url) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: "Replicate video prediction returned no URL.",
      retryable: true,
    });
  }
  // Replicate may return image URLs alongside; use the first URL as video.
  return downloadVideo(url);
}

// ---------------------------------------------------------------------------
// MiniMax — video-generation REST (async, polled)
// ---------------------------------------------------------------------------

interface MiniMaxCreated {
  task_id?: string;
}
interface MiniMaxStatus {
  status?: "Queueing" | "Preparing" | "Processing" | "Success" | "Fail";
  file_id?: string;
}

async function generateVideoMiniMax(
  config: ResolvedByokVideoConfig,
  input: GenerateVideoByokInput,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const apiBase = config.endpoint.replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: config.modelId,
    prompt: input.prompt,
  };
  if (input.referenceImage) {
    body.first_frame_image = bufferToDataUrl(input.referenceImage);
  }
  let createResp: Response;
  try {
    createResp = await fetch(`${apiBase}/video_generation`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: withTimeoutSignal(input.abortSignal, 60_000),
    });
  } catch {
    throw new ApiError({
      status: 504,
      code: "provider_timeout",
      message: "MiniMax video request timed out.",
      retryable: true,
    });
  }
  if (!createResp.ok) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `MiniMax rejected video request (${createResp.status}).`,
      retryable: createResp.status >= 500,
    });
  }
  const created = (await createResp.json().catch(() => ({}))) as MiniMaxCreated;
  if (!created.task_id) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: "MiniMax did not return a task id.",
      retryable: true,
    });
  }

  const status: MiniMaxStatus = await pollUntil<MiniMaxStatus>({
    fetcher: async () => {
      let statusResp: Response;
      try {
        statusResp = await fetch(
          `${apiBase}/query/video_generation?task_id=${encodeURIComponent(created.task_id!)}`,
          {
            headers: { Authorization: `Bearer ${config.apiKey}` },
            cache: "no-store",
            signal: withTimeoutSignal(input.abortSignal, 15_000),
          },
        );
      } catch {
        throw new ApiError({
          status: 504,
          code: "provider_timeout",
          message: "MiniMax video status poll timed out.",
          retryable: true,
        });
      }
      if (!statusResp.ok) {
        throw new ApiError({
          status: 502,
          code: "provider_error",
          message: `MiniMax video status poll failed (${statusResp.status}).`,
          retryable: statusResp.status >= 500,
        });
      }
      return (await statusResp.json().catch(() => ({}))) as MiniMaxStatus;
    },
    isDone: (s) =>
      s.status !== "Queueing" && s.status !== "Preparing" && s.status !== "Processing",
    deadlineMs: 10 * 60_000,
    intervalMs: 3000,
    backoffMultiplier: 1.2,
    maxIntervalMs: 10_000,
    jitterRatio: 0.2,
    label: "MiniMax video",
  });
  // Split the two failure modes — the previous combined condition reported
  // `MiniMax video Success` when status was "Success" but file_id was empty,
  // which is the opposite of what happened. Distinguishing them lets the
  // user know whether to retry (genuine failure) or report a vendor bug
  // (success-without-payload).
  if (status.status !== "Success") {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `MiniMax video task ${status.status ?? "unknown"}.`,
      retryable: true,
    });
  }
  if (!status.file_id) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: "MiniMax video task succeeded but returned no file_id.",
      retryable: true,
    });
  }

  let fileResp: Response;
  try {
    fileResp = await fetch(
      `${apiBase}/files/retrieve?file_id=${encodeURIComponent(status.file_id)}`,
      {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        cache: "no-store",
        signal: withTimeoutSignal(input.abortSignal, 30_000),
      },
    );
  } catch {
    throw new ApiError({
      status: 504,
      code: "provider_timeout",
      message: "MiniMax video file fetch timed out.",
      retryable: true,
    });
  }
  if (!fileResp.ok) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `MiniMax video file fetch failed (${fileResp.status}).`,
      retryable: fileResp.status >= 500,
    });
  }
  const fileJson = (await fileResp.json().catch(() => ({}))) as {
    file?: { download_url?: string };
  };
  const url = fileJson.file?.download_url;
  if (!url) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: "MiniMax video file URL missing.",
      retryable: true,
    });
  }
  return downloadVideo(url);
}

const VIDEO_GENERATORS = {
  fal: generateVideoFal,
  replicate: generateVideoReplicate,
  minimax: generateVideoMiniMax,
} satisfies Record<Exclude<ByokVideoApiMode, "none">, VideoGenerator>;

function requireVideoMode(meta: { label: string; videoApiMode?: ByokVideoApiMode }): Exclude<ByokVideoApiMode, "none"> {
  if (!meta.videoApiMode || meta.videoApiMode === "none") {
    throw new ApiError({
      status: 400,
      code: "byok_video_unsupported",
      message: `${meta.label} does not support video generation.`,
      retryable: false,
    });
  }
  return meta.videoApiMode;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function generateVideoByok(
  input: GenerateVideoByokInput,
  providerId: string,
): Promise<GenerateVideoByokResult> {
  const resolved = await resolveByokProviderConfig({
    providerId,
    validateProvider(meta) {
      requireVideoMode(meta);
    },
    // No fallback to a catalog default — empty stays empty. If the user did not
    // pick a video model id in Settings, surface the configuration error instead
    // of silently routing to an arbitrary model.
    resolveModelId: ({ connection }) => input.modelId?.trim() || connection?.models?.video,
    missingEndpointMessage: (meta) => `${meta.label} video is missing endpoint or model id. Open Settings to configure.`,
    missingModelMessage: (meta) => `${meta.label} video is missing endpoint or model id. Open Settings to configure.`,
  });
  const meta = resolved.providerMeta;
  const videoMode = requireVideoMode(meta);
  const config: ResolvedByokVideoConfig = {
    providerId,
    apiKey: resolved.apiKey,
    endpoint: resolved.endpoint,
    modelId: resolved.modelId,
  };

  const video = await VIDEO_GENERATORS[videoMode](config, input);

  return {
    provider: `byok:${providerId}`,
    model: resolved.modelId,
    video,
  };
}
