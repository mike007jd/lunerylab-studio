import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  class FalApiError extends Error {
    status: number;
    body: unknown;
    requestId: string;

    constructor({
      message,
      status,
      body,
      requestId,
    }: {
      message: string;
      status: number;
      body?: unknown;
      requestId?: string;
    }) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
      this.requestId = requestId ?? "";
    }
  }
  const falSubscribe = vi.fn();
  const createFalClient = vi.fn((config) => {
    state.falConfig = config;
    return { subscribe: falSubscribe };
  });
  const predictionsCreate = vi.fn();
  const predictionsCancel = vi.fn();
  const replicateWait = vi.fn();
  const Replicate = vi.fn(function MockReplicate(options) {
    state.replicateOptions = options;
    return {
      predictions: {
        create: predictionsCreate,
        cancel: predictionsCancel,
      },
      wait: replicateWait,
    };
  });
  const state: {
    falConfig?: {
      credentials: string;
      requestMiddleware: (request: {
        method: string;
        url: string;
        headers?: Record<string, string>;
      }) => Promise<{ method: string; url: string; headers?: Record<string, string> }>;
    };
    replicateOptions?: Record<string, unknown>;
  } = {};
  return {
    state,
    falSubscribe,
    createFalClient,
    predictionsCreate,
    predictionsCancel,
    replicateWait,
    Replicate,
    FalApiError,
  };
});

vi.mock("@fal-ai/client", () => ({
  createFalClient: mocks.createFalClient,
  ApiError: mocks.FalApiError,
}));

vi.mock("replicate", () => ({
  default: mocks.Replicate,
}));

import {
  falQueueResult,
  parseReplicateModelRef,
  runReplicatePrediction,
} from "@/lib/server/byok-provider-clients";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.falConfig = undefined;
  mocks.state.replicateOptions = undefined;
  mocks.falSubscribe.mockResolvedValue({
    data: { images: [{ url: "https://cdn.example.test/result.png" }] },
  });
  mocks.predictionsCreate.mockResolvedValue({
    id: "pred-1",
    status: "succeeded",
    output: ["https://cdn.example.test/result.png"],
    urls: { get: "https://api.replicate.com/v1/predictions/pred-1" },
  });
  mocks.replicateWait.mockImplementation(async (prediction) => prediction);
});

describe("BYOK provider clients", () => {
  it("uses the official Replicate client for path-style predictions", async () => {
    const prediction = await runReplicatePrediction({
      apiKey: "rep-token",
      apiBase: "https://api.replicate.com/v1",
      modelId: "owner/model",
      input: { prompt: "product shot" },
      label: "Replicate image",
      deadlineMs: 30_000,
    });

    expect(mocks.Replicate).toHaveBeenCalledWith({
      auth: "rep-token",
      baseUrl: "https://api.replicate.com/v1",
      useFileOutput: false,
    });
    expect(mocks.predictionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { prompt: "product shot" },
        model: "owner/model",
        wait: 30,
      }),
    );
    expect(prediction.output).toEqual(["https://cdn.example.test/result.png"]);
  });

  it("uses official Fal subscribe while preserving custom endpoint rewriting", async () => {
    const payload = await falQueueResult<{ images: Array<{ url: string }> }>({
      apiKey: "fal-key",
      apiBase: "https://fal-proxy.example.test/base",
      modelPath: "fal-ai/flux-pro/v1.1",
      body: { prompt: "packshot" },
      deadlineMs: 45_000,
      label: "Fal image",
    });

    expect(mocks.createFalClient).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: "fal-key",
      }),
    );
    expect(mocks.falSubscribe).toHaveBeenCalledWith(
      "fal-ai/flux-pro/v1.1",
      expect.objectContaining({
        input: { prompt: "packshot" },
        mode: "polling",
        pollInterval: 3000,
        timeout: 45_000,
      }),
    );
    expect(payload.images[0]?.url).toBe("https://cdn.example.test/result.png");

    const rewritten = await mocks.state.falConfig!.requestMiddleware({
      method: "get",
      url: "https://queue.fal.run/fal-ai/flux-pro/v1.1/requests/abc/status",
      headers: {},
    });
    expect(rewritten.url).toBe(
      "https://fal-proxy.example.test/base/fal-ai/flux-pro/v1.1/requests/abc/status",
    );
  });

  it("keeps Replicate version-only selections valid", () => {
    const version = "a".repeat(64);
    expect(parseReplicateModelRef(`owner/model:${version}`)).toEqual({
      usePathStyle: false,
      versionId: version,
    });
  });

  it("preserves non-retryable Fal validation errors", async () => {
    mocks.falSubscribe.mockRejectedValueOnce(
      new mocks.FalApiError({
        message: "Validation error",
        status: 422,
        body: { detail: "image_url is required" },
        requestId: "fal-req-1",
      }),
    );

    await expect(
      falQueueResult({
        apiKey: "fal-key",
        apiBase: "https://queue.fal.run",
        modelPath: "fal-ai/flux-pro/v1.1",
        body: { prompt: "packshot" },
        deadlineMs: 45_000,
        label: "Fal image",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_argument",
      retryable: false,
      message: expect.stringContaining("422"),
    });
  });
});
