import "server-only";

import { createFalClient } from "@fal-ai/client";
import { ApiError as FalApiError } from "@fal-ai/client";
import Replicate, { type Prediction as ReplicateSdkPrediction } from "replicate";
import { ApiError } from "@/lib/server/errors";
import { withTimeoutSignal } from "@/lib/server/byok-shared";

const REPLICATE_VERSION_HEX = /^[a-f0-9]{64}$/i;
const REPLICATE_PATH_STYLE = /^[a-z0-9._-]+\/[a-z0-9._-]+$/i;

export function parseReplicateModelRef(
  modelId: string,
  label = "Replicate",
):
  | { usePathStyle: true; versionId?: undefined }
  | { usePathStyle: false; versionId: string } {
  if (REPLICATE_PATH_STYLE.test(modelId)) {
    return { usePathStyle: true };
  }
  const candidate = modelId.includes(":") ? modelId.split(":")[1] : modelId;
  const value = candidate?.trim();
  if (!value || !REPLICATE_VERSION_HEX.test(value)) {
    throw new ApiError({
      status: 400,
      code: "invalid_model",
      message: `${label} model id must be either \`owner/name\` (path style) or \`owner/name:<64-char-version>\`.`,
      retryable: false,
    });
  }
  return { usePathStyle: false, versionId: value };
}

export interface ReplicatePrediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled" | "aborted";
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
}

type ReplicateHttpErrorClassifier = (
  status: number,
  body: string,
  phase: "create" | "poll",
) => ApiError;

function defaultReplicateHttpError(label: string): ReplicateHttpErrorClassifier {
  return (status, body, phase) =>
    new ApiError({
      status: 502,
      code: "provider_error",
      message: `${label} ${phase === "create" ? "request" : "poll"} failed (${status}). ${body.slice(0, 200)}`.trim(),
      retryable: status >= 500,
    });
}

function classifyReplicateSdkError(
  error: unknown,
  label: string,
  phase: "create" | "poll",
  classify: ReplicateHttpErrorClassifier,
): ApiError {
  if (error instanceof ApiError) return error;
  const maybe = error as {
    name?: string;
    message?: string;
    response?: { status?: number };
  } | null;
  const status = maybe?.response?.status;
  if (typeof status === "number") {
    return classify(status, maybe?.message ?? "", phase);
  }
  if (maybe?.name === "AbortError" || maybe?.name === "TimeoutError") {
    return new ApiError({
      status: 504,
      code: "provider_timeout",
      message: `${label} ${phase === "create" ? "request" : "poll"} timed out.`,
      retryable: true,
    });
  }
  return new ApiError({
    status: 502,
    code: "provider_error",
    message: `${label} ${phase === "create" ? "request" : "poll"} failed. ${maybe?.message?.slice(0, 200) ?? ""}`.trim(),
    retryable: true,
  });
}

function toReplicatePrediction(prediction: ReplicateSdkPrediction): ReplicatePrediction {
  return {
    id: prediction.id,
    status: prediction.status,
    output: prediction.output,
    error: prediction.error,
    urls: prediction.urls,
  };
}

export async function runReplicatePrediction(params: {
  apiKey: string;
  apiBase: string;
  modelId: string;
  input: Record<string, unknown>;
  label: string;
  deadlineMs: number;
  intervalMs?: number;
  classifyHttpError?: ReplicateHttpErrorClassifier;
  abortSignal?: AbortSignal;
}): Promise<ReplicatePrediction> {
  const apiBase = params.apiBase.replace(/\/+$/, "");
  const { usePathStyle, versionId } = parseReplicateModelRef(params.modelId, params.label);
  const classify = params.classifyHttpError ?? defaultReplicateHttpError(params.label);
  const replicate = new Replicate({
    auth: params.apiKey,
    baseUrl: apiBase,
    useFileOutput: false,
  });

  let prediction: ReplicateSdkPrediction;
  try {
    prediction = await replicate.predictions.create({
      input: params.input,
      wait: 30,
      signal: withTimeoutSignal(params.abortSignal, 60_000),
      ...(usePathStyle ? { model: params.modelId } : { version: versionId }),
    });
  } catch (error) {
    throw classifyReplicateSdkError(error, params.label, "create", classify);
  }
  if (!prediction?.id) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `${params.label} returned an invalid prediction.`,
      retryable: true,
    });
  }

  const deadline = Date.now() + params.deadlineMs;
  if (prediction.status === "starting" || prediction.status === "processing") {
    try {
      // The Replicate SDK's wait() takes no AbortSignal, so we stop polling via
      // the stop callback when the caller cancels (user "Stop") — then cancel the
      // prediction so it stops running and billing instead of finishing orphaned.
      prediction = await replicate.wait(
        prediction,
        { interval: params.intervalMs ?? 3000 },
        async () => Boolean(params.abortSignal?.aborted) || Date.now() > deadline,
      );
      if (prediction.status === "starting" || prediction.status === "processing") {
        await replicate.predictions.cancel(prediction.id).catch(() => null);
        if (params.abortSignal?.aborted) {
          throw new ApiError({
            status: 499,
            code: "request_aborted",
            message: `${params.label} was cancelled.`,
            retryable: false,
          });
        }
        throw new ApiError({
          status: 504,
          code: "provider_timeout",
          message: `${params.label} did not complete within ${Math.round(params.deadlineMs / 1000)} seconds.`,
          retryable: true,
        });
      }
    } catch (error) {
      throw classifyReplicateSdkError(error, params.label, "poll", classify);
    }
  }

  if (prediction.status !== "succeeded") {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `${params.label} ${prediction.status}: ${prediction.error ?? "no detail"}`,
      retryable: true,
    });
  }
  return toReplicatePrediction(prediction);
}

interface FalQueueParams {
  apiKey: string;
  apiBase: string;
  modelPath: string;
  body: Record<string, unknown>;
  deadlineMs: number;
  label: string;
  abortSignal?: AbortSignal;
}

function rewriteFalTargetUrl(targetUrl: string, apiBase: string): string {
  const target = new URL(targetUrl);
  const base = new URL(apiBase.endsWith("/") ? apiBase : `${apiBase}/`);
  const basePath = base.pathname.replace(/\/$/, "");
  target.protocol = base.protocol;
  target.host = base.host;
  target.pathname = `${basePath}/${target.pathname.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  return target.toString();
}

function classifyFalSdkError(error: unknown, label: string): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof FalApiError) {
    const detail =
      typeof error.body === "string"
        ? error.body
        : error.body
          ? JSON.stringify(error.body)
          : error.message;
    const retryable = error.status === 429 || error.status >= 500;
    return new ApiError({
      status: error.status === 429 ? 429 : error.status >= 500 ? 502 : 400,
      code:
        error.status === 401 || error.status === 403
          ? "missing_api_key"
          : error.status === 429
            ? "quota_exceeded"
            : error.status >= 500
              ? "provider_error"
              : "invalid_argument",
      message: `${label} failed (${error.status}${error.requestId ? `, request ${error.requestId}` : ""}). ${detail.slice(0, 200)}`.trim(),
      retryable,
    });
  }
  const maybe = error as { name?: string; message?: string; status?: number } | null;
  if (maybe?.name === "AbortError" || maybe?.name === "TimeoutError") {
    return new ApiError({
      status: 504,
      code: "provider_timeout",
      message: `${label} request timed out.`,
      retryable: true,
    });
  }
  const status = maybe?.status;
  return new ApiError({
    status: status === 429 ? 429 : status && status >= 500 ? 502 : 502,
    code: status === 429 ? "quota_exceeded" : "provider_error",
    message: `${label} failed. ${maybe?.message?.slice(0, 200) ?? ""}`.trim(),
    retryable: status === undefined || status === 429 || status >= 500,
  });
}

export async function falQueueResult<TResult = unknown>(params: FalQueueParams): Promise<TResult> {
  const apiBase = params.apiBase.replace(/\/+$/, "");
  const client = createFalClient({
    credentials: params.apiKey,
    requestMiddleware: async (request) => ({
      ...request,
      url: rewriteFalTargetUrl(request.url, apiBase),
    }),
  });
  try {
    const result = await client.subscribe(params.modelPath as never, {
      input: params.body as never,
      mode: "polling",
      pollInterval: 3000,
      timeout: params.deadlineMs,
      abortSignal: withTimeoutSignal(params.abortSignal, params.deadlineMs + 15_000),
    });
    return result.data as TResult;
  } catch (error) {
    throw classifyFalSdkError(error, params.label);
  }
}

export async function falQueueSubmit<TResult = unknown>(
  params: FalQueueParams & {
    extractUrl: (payload: TResult) => string | undefined;
  },
): Promise<string> {
  const payload = await falQueueResult<TResult>(params);
  const url = params.extractUrl(payload);
  if (!url) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `${params.label} returned no result URL.`,
      retryable: true,
    });
  }
  return url;
}
