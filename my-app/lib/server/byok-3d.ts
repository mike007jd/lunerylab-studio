/**
 * BYOK 3D model generation.
 *
 * Supports image-to-3D via three provider families:
 *   - "meshy"     → Meshy Image-to-3D API
 *   - "tripo"     → Tripo Image-to-Model API
 *   - "fal"       → fal queue (e.g. fal-ai/triposr, fal-ai/hunyuan3d-2)
 *   - "replicate" → /v1/predictions (e.g. adirik/triposr-v2)
 *
 * The returned asset is a GLB binary in most cases; OBJ may come back from
 * Tripo as a fallback. Callers handle the mime via the result's `mimeType`.
 */

import "server-only";
import { ApiError } from "@/lib/server/errors";
import type { ByokModel3dApiMode, ByokProviderMeta } from "@/lib/byok-providers";
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

export interface GenerateModel3dByokInput {
  /** Required: PNG / JPEG bytes of the source image. */
  referenceImage: Buffer;
  /** Optional natural-language prompt some providers accept. */
  prompt?: string;
  /** Preferred export format (provider-dependent). */
  format?: "glb" | "obj" | "fbx";
  /**
   * Optional override for vendor-specific model identifiers that are NOT
   * surfaced through a user-selectable BYOK modelId. Meshy uses this for the
   * `ai_model` field (e.g. "latest", "meshy-5"). Leave undefined to use the
   * provider metadata value that carries sourceEvidence + freshnessExpiresAt.
   */
  aiModel?: string;
  /** Cancels provider submission, polling, and the final model download. */
  abortSignal?: AbortSignal;
}

export interface GenerateModel3dByokResult {
  provider: string;
  model: string;
  bytes: Buffer;
  mimeType: string;
  format: "glb" | "obj" | "fbx";
}

interface ResolvedConfig {
  providerId: string;
  providerMeta: ByokProviderMeta;
  apiKey: string;
  endpoint: string;
  modelId: string;
}

type Model3dGenerator = (
  config: ResolvedConfig,
  input: GenerateModel3dByokInput,
) => Promise<{ bytes: Buffer; mimeType: string; format: "glb" | "obj" | "fbx" }>;

async function downloadBinary(
  url: string,
  defaultFormat: "glb" | "obj" | "fbx" = "glb",
  abortSignal?: AbortSignal,
): Promise<{ bytes: Buffer; mimeType: string; format: "glb" | "obj" | "fbx" }> {
  const downloaded = await downloadRemoteBytes(url, {
    maxBytes: 768 * 1024 * 1024,
    timeoutMs: 120_000,
    fallbackMimeType: "model/gltf-binary",
    label: "Generated 3D asset URL",
    abortSignal,
  });
  const contentType = downloaded.mimeType;
  const lowerUrl = url.toLowerCase();
  let format: "glb" | "obj" | "fbx" = defaultFormat;
  if (lowerUrl.endsWith(".obj")) format = "obj";
  else if (lowerUrl.endsWith(".fbx")) format = "fbx";
  else if (lowerUrl.endsWith(".glb")) format = "glb";
  const mimeMap = {
    glb: "model/gltf-binary",
    obj: "model/obj",
    fbx: "model/vnd.fbx",
  } as const;
  return {
    bytes: downloaded.bytes,
    mimeType: contentType || mimeMap[format],
    format,
  };
}

// ---------------------------------------------------------------------------
// Meshy
// ---------------------------------------------------------------------------

interface MeshyCreated {
  result?: string;
  task_id?: string;
}
interface MeshyTaskStatus {
  status?: "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED";
  model_urls?: { glb?: string; obj?: string; fbx?: string };
  error?: string;
}

async function generateModel3dMeshy(
  config: ResolvedConfig,
  input: GenerateModel3dByokInput,
): Promise<{ bytes: Buffer; mimeType: string; format: "glb" | "obj" | "fbx" }> {
  const apiBase = config.endpoint.replace(/\/+$/, "");
  const createResp = await fetch(`${apiBase}/v1/image-to-3d`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image_url: bufferToDataUrl(input.referenceImage),
      enable_pbr: true,
      ai_model: input.aiModel?.trim() || config.providerMeta.model3dDefaultParams?.aiModel,
      topology: "quad",
    }),
    signal: withTimeoutSignal(input.abortSignal, 60_000),
  });
  if (!createResp.ok) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `Meshy rejected image-to-3D request (${createResp.status}).`,
      retryable: createResp.status >= 500,
    });
  }
  const created = (await createResp.json().catch(() => ({}))) as MeshyCreated;
  const taskId = created.result || created.task_id;
  if (!taskId) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: "Meshy did not return a task id.",
      retryable: true,
    });
  }

  const status = await pollUntil<MeshyTaskStatus>({
    fetcher: async () => {
      const statusResp = await fetch(`${apiBase}/v1/image-to-3d/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        cache: "no-store",
        signal: withTimeoutSignal(input.abortSignal, 15_000),
      });
      if (!statusResp.ok) {
        throw new ApiError({
          status: 502,
          code: statusResp.status === 401 || statusResp.status === 403 ? "provider_auth_failed" : "provider_error",
          message: `Meshy image-to-3D status check failed (${statusResp.status}).`,
          retryable: statusResp.status >= 500,
        });
      }
      return (await statusResp.json().catch(() => ({}))) as MeshyTaskStatus;
    },
    isDone: (s) => s.status !== "PENDING" && s.status !== "IN_PROGRESS",
    deadlineMs: 10 * 60_000,
    intervalMs: 3500,
    backoffMultiplier: 1.2,
    maxIntervalMs: 10_000,
    jitterRatio: 0.2,
    label: "Meshy image-to-3D",
    abortSignal: input.abortSignal,
  });
  if (status.status !== "SUCCEEDED") {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `Meshy image-to-3D ${status.status}: ${status.error ?? "no detail"}`,
      retryable: true,
    });
  }
  const url =
    status.model_urls?.glb ?? status.model_urls?.obj ?? status.model_urls?.fbx;
  if (!url) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: "Meshy returned no downloadable model URL.",
      retryable: true,
    });
  }
  return downloadBinary(url, "glb", input.abortSignal);
}

// ---------------------------------------------------------------------------
// Tripo
// ---------------------------------------------------------------------------

interface TripoCreated {
  code?: number;
  data?: { task_id?: string };
}
interface TripoStatus {
  data?: {
    status?: "queued" | "running" | "success" | "failed" | "canceled";
    output?: { model?: string; pbr_model?: string };
    error?: string;
  };
}

async function generateModel3dTripo(
  config: ResolvedConfig,
  input: GenerateModel3dByokInput,
): Promise<{ bytes: Buffer; mimeType: string; format: "glb" | "obj" | "fbx" }> {
  const apiBase = config.endpoint.replace(/\/+$/, "");
  const createResp = await fetch(`${apiBase}/task`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "image_to_model",
      file: { type: "image", object: bufferToDataUrl(input.referenceImage) },
      model_version: input.aiModel?.trim() || config.providerMeta.model3dDefaultParams?.modelVersion,
      output_format: input.format ?? "glb",
    }),
    signal: withTimeoutSignal(input.abortSignal, 60_000),
  });
  if (!createResp.ok) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `Tripo rejected image-to-3D request (${createResp.status}).`,
      retryable: createResp.status >= 500,
    });
  }
  const created = (await createResp.json().catch(() => ({}))) as TripoCreated;
  const taskId = created.data?.task_id;
  if (!taskId) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: "Tripo did not return a task id.",
      retryable: true,
    });
  }

  const status = await pollUntil<TripoStatus>({
    fetcher: async () => {
      const statusResp = await fetch(`${apiBase}/task/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        cache: "no-store",
        signal: withTimeoutSignal(input.abortSignal, 15_000),
      });
      if (!statusResp.ok) {
        throw new ApiError({
          status: 502,
          code: statusResp.status === 401 || statusResp.status === 403 ? "provider_auth_failed" : "provider_error",
          message: `Tripo image-to-3D status check failed (${statusResp.status}).`,
          retryable: statusResp.status >= 500,
        });
      }
      return (await statusResp.json().catch(() => ({}))) as TripoStatus;
    },
    isDone: (s) =>
      Boolean(s.data?.status) && s.data?.status !== "queued" && s.data?.status !== "running",
    deadlineMs: 10 * 60_000,
    intervalMs: 3500,
    backoffMultiplier: 1.2,
    maxIntervalMs: 10_000,
    jitterRatio: 0.2,
    label: "Tripo image-to-3D",
    abortSignal: input.abortSignal,
  });
  if (status.data?.status !== "success") {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `Tripo image-to-3D ${status.data?.status}: ${status.data?.error ?? "no detail"}`,
      retryable: true,
    });
  }
  const url = status.data.output?.pbr_model ?? status.data.output?.model;
  if (!url) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: "Tripo returned no model URL.",
      retryable: true,
    });
  }
  return downloadBinary(url, input.format ?? "glb", input.abortSignal);
}

// ---------------------------------------------------------------------------
// fal — queue + poll (shared client lives in byok-shared.falQueueSubmit)
// ---------------------------------------------------------------------------

interface Fal3dPayload {
  model_mesh?: { url?: string; content_type?: string; file_name?: string };
  model?: { url?: string; content_type?: string };
}

async function generateModel3dFal(
  config: ResolvedConfig,
  input: GenerateModel3dByokInput,
): Promise<{ bytes: Buffer; mimeType: string; format: "glb" | "obj" | "fbx" }> {
  const body: Record<string, unknown> = {
    image_url: bufferToDataUrl(input.referenceImage),
  };
  if (input.prompt) body.prompt = input.prompt;
  const url = await falQueueSubmit<Fal3dPayload>({
    apiKey: config.apiKey,
    apiBase: config.endpoint,
    modelPath: config.modelId,
    body,
    extractUrl: (p) => p.model_mesh?.url ?? p.model?.url,
    deadlineMs: 10 * 60_000,
    label: "Fal 3D",
    abortSignal: input.abortSignal,
  });
  return downloadBinary(url, "glb", input.abortSignal);
}

// ---------------------------------------------------------------------------
// Replicate — predictions + poll
// ---------------------------------------------------------------------------

async function generateModel3dReplicate(
  config: ResolvedConfig,
  input: GenerateModel3dByokInput,
): Promise<{ bytes: Buffer; mimeType: string; format: "glb" | "obj" | "fbx" }> {
  const apiBase = config.endpoint.replace(/\/+$/, "");
  const prediction = await runReplicatePrediction({
    apiKey: config.apiKey,
    apiBase,
    modelId: config.modelId,
    label: "Replicate 3D",
    deadlineMs: 10 * 60_000,
    abortSignal: input.abortSignal,
    input: {
      image: bufferToDataUrl(input.referenceImage),
      ...(input.prompt ? { prompt: input.prompt } : {}),
    },
  });
  const output = Array.isArray(prediction.output) ? prediction.output : [prediction.output];
  const url = output.find((v): v is string => typeof v === "string" && /\.(glb|obj|fbx)/i.test(v));
  if (!url) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: "Replicate 3D returned no recognized model URL.",
      retryable: true,
    });
  }
  return downloadBinary(url, "glb", input.abortSignal);
}

const MODEL_3D_GENERATORS = {
  meshy: generateModel3dMeshy,
  tripo: generateModel3dTripo,
  fal: generateModel3dFal,
  replicate: generateModel3dReplicate,
} satisfies Record<Exclude<ByokModel3dApiMode, "none">, Model3dGenerator>;

function requireModel3dMode(meta: { label: string; modelApiMode?: ByokModel3dApiMode }): Exclude<ByokModel3dApiMode, "none"> {
  if (!meta.modelApiMode || meta.modelApiMode === "none") {
    throw new ApiError({
      status: 400,
      code: "byok_3d_unsupported",
      message: `${meta.label} does not support 3D model generation.`,
      retryable: false,
    });
  }
  return meta.modelApiMode;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function generateModel3dByok(
  input: GenerateModel3dByokInput,
  providerId: string,
): Promise<GenerateModel3dByokResult> {
  const resolved = await resolveByokProviderConfig({
    providerId,
    validateProvider(meta) {
      requireModel3dMode(meta);
    },
    // Meshy / Tripo expose a single fixed operation (image-to-3D), not a model
    // pick — for those, `fixedModel3dOperation` is a job-tag label, not a
    // user-substituted default. For replicate / fal the user must pick a model
    // id explicitly.
    resolveModelId: ({ meta, connection }) => connection?.models?.model3d?.trim() || meta.fixedModel3dOperation,
    missingEndpointMessage: (meta) => `${meta.label} 3D is missing an endpoint. Open Settings to configure.`,
    missingModelMessage: (meta) => `${meta.label} 3D requires a model id. Open Settings and choose a model.`,
  });
  const meta = resolved.providerMeta;
  const model3dMode = requireModel3dMode(meta);
  const config: ResolvedConfig = {
    providerId,
    providerMeta: meta,
    apiKey: resolved.apiKey,
    endpoint: resolved.endpoint,
    modelId: resolved.modelId,
  };

  const result = await MODEL_3D_GENERATORS[model3dMode](config, input);

  return {
    provider: `byok:${providerId}`,
    model: resolved.modelId,
    ...result,
  };
}
