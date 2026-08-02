import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireDesktopBridge: vi.fn(),
  startBridgeDownloadJob: vi.fn(),
  probeBridgeDownloadJob: vi.fn(),
  bridgeErrorText: vi.fn(),
  proxyToBridge: vi.fn(),
  findHfModelEntry: vi.fn(),
  modelCachePath: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/server/desktop-bridge", () => ({
  requireDesktopBridge: mocks.requireDesktopBridge,
  startBridgeDownloadJob: mocks.startBridgeDownloadJob,
  probeBridgeDownloadJob: mocks.probeBridgeDownloadJob,
  bridgeErrorText: mocks.bridgeErrorText,
  proxyToBridge: mocks.proxyToBridge,
  BridgeDownloadControlError: class BridgeDownloadControlError extends Error {
    code: string;
    retryable = true as const;
    jobId?: string;
    constructor(
      message: string,
      options: { code: string; jobId?: string; cause?: unknown },
    ) {
      super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
      this.name = "BridgeDownloadControlError";
      this.code = options.code;
      this.jobId = options.jobId;
    }
  },
}));

vi.mock("@/lib/hf-model-catalog", () => ({
  findHfModelEntry: mocks.findHfModelEntry,
}));

vi.mock("@/lib/server/imported-model-registry", () => ({
  modelCachePath: mocks.modelCachePath,
}));

import { BridgeDownloadControlError } from "@/lib/server/desktop-bridge";
import { POST } from "./route";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const MODEL_ID = "qwen3.6-35b-a3b-ud-q4-k-m";

function startRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/desktop-runtime/hf-download", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireDesktopBridge.mockReturnValue({ url: "http://127.0.0.1:9", token: "t" });
  mocks.findHfModelEntry.mockReturnValue({
    id: MODEL_ID,
    fileName: "model.gguf",
    downloadUrl: "https://huggingface.co/org/model/resolve/main/model.gguf",
    sha256: "a".repeat(64),
    runtimeTarget: "llama-cpp",
    sizeBytes: 10,
  });
  mocks.modelCachePath.mockReturnValue("/models/llama-cpp/model.gguf");
  mocks.bridgeErrorText.mockResolvedValue("rejected");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/desktop-runtime/hf-download control plane", () => {
  it("forwards the client-supplied jobId in the bridge start payload", async () => {
    mocks.startBridgeDownloadJob.mockResolvedValue(new Response(null, { status: 200 }));

    const response = await POST(
      startRequest({ modelId: MODEL_ID, jobId: JOB_ID }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ jobId: JOB_ID });
    expect(mocks.startBridgeDownloadJob).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://127.0.0.1:9" }),
      expect.objectContaining({
        jobId: JOB_ID,
        url: "https://huggingface.co/org/model/resolve/main/model.gguf",
        dest: "/models/llama-cpp/model.gguf",
      }),
    );
  });

  it("recovers a lost start response when status observes the accepted job", async () => {
    mocks.startBridgeDownloadJob.mockRejectedValue(
      new BridgeDownloadControlError("Desktop runtime bridge is unreachable", {
        code: "bridge_unreachable",
        jobId: JOB_ID,
      }),
    );
    mocks.probeBridgeDownloadJob.mockResolvedValue({
      outcome: "observed",
      jobId: JOB_ID,
      status: "downloading",
      body: { status: "downloading" },
    });

    const response = await POST(
      startRequest({ modelId: MODEL_ID, jobId: JOB_ID }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jobId: JOB_ID,
      recovered: true,
    });
    expect(mocks.probeBridgeDownloadJob).toHaveBeenCalledWith(
      expect.anything(),
      JOB_ID,
    );
  });

  it("keeps retryable ambiguous ownership when start and status stay unknown", async () => {
    mocks.startBridgeDownloadJob.mockRejectedValue(
      new BridgeDownloadControlError("Desktop runtime bridge timed out", {
        code: "bridge_timeout",
        jobId: JOB_ID,
      }),
    );
    mocks.probeBridgeDownloadJob.mockResolvedValue({
      outcome: "ambiguous",
      jobId: JOB_ID,
      code: "bridge_timeout",
    });

    const response = await POST(
      startRequest({ modelId: MODEL_ID, jobId: JOB_ID }),
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      code: "bridge_timeout",
      jobId: JOB_ID,
      retryable: true,
      partialState: true,
    });
  });

  it("retries the same client jobId idempotently on a second identical start", async () => {
    mocks.startBridgeDownloadJob.mockResolvedValue(new Response(null, { status: 200 }));

    const first = await POST(startRequest({ modelId: MODEL_ID, jobId: JOB_ID }));
    const second = await POST(startRequest({ modelId: MODEL_ID, jobId: JOB_ID }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.startBridgeDownloadJob).toHaveBeenCalledTimes(2);
    expect(mocks.startBridgeDownloadJob.mock.calls[0]?.[1]).toMatchObject({ jobId: JOB_ID });
    expect(mocks.startBridgeDownloadJob.mock.calls[1]?.[1]).toMatchObject({ jobId: JOB_ID });
    expect(mocks.startBridgeDownloadJob.mock.calls[0]?.[1]).toEqual(
      mocks.startBridgeDownloadJob.mock.calls[1]?.[1],
    );
  });

  it("terminally fails only on a definitive bridge rejection", async () => {
    mocks.startBridgeDownloadJob.mockResolvedValue(new Response("conflict", { status: 409 }));
    mocks.bridgeErrorText.mockResolvedValue("jobId payload conflict");

    const response = await POST(
      startRequest({ modelId: MODEL_ID, jobId: JOB_ID }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Bridge start failed: jobId payload conflict",
      jobId: JOB_ID,
      retryable: false,
    });
    expect(mocks.probeBridgeDownloadJob).not.toHaveBeenCalled();
  });

  it("rejects requests without a client-supplied UUID jobId", async () => {
    const response = await POST(startRequest({ modelId: MODEL_ID }));
    expect(response.status).toBe(400);
    expect(mocks.startBridgeDownloadJob).not.toHaveBeenCalled();
  });

  it("returns bridge unavailable when the desktop bridge is missing", async () => {
    mocks.requireDesktopBridge.mockReturnValue(
      NextResponse.json({ error: "Desktop runtime bridge is not available" }, { status: 404 }),
    );

    const response = await POST(
      startRequest({ modelId: MODEL_ID, jobId: JOB_ID }),
    );

    expect(response.status).toBe(404);
    expect(mocks.startBridgeDownloadJob).not.toHaveBeenCalled();
  });
});
