import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireDesktopBridge: vi.fn(),
  startBridgeDownloadJob: vi.fn(),
  probeBridgeDownloadJob: vi.fn(),
  bridgeErrorText: vi.fn(),
  upsertImportedModel: vi.fn(),
  withQueuedImportedModelReservation: vi.fn(),
  findImportedModel: vi.fn(),
  resolveHuggingFaceModelFileUrl: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/desktop-bridge", () => ({
  requireDesktopBridge: mocks.requireDesktopBridge,
  startBridgeDownloadJob: mocks.startBridgeDownloadJob,
  probeBridgeDownloadJob: mocks.probeBridgeDownloadJob,
  bridgeErrorText: mocks.bridgeErrorText,
}));
vi.mock("@/lib/server/imported-model-registry", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/imported-model-registry")>(
    "@/lib/server/imported-model-registry",
  );
  return {
    ...actual,
    upsertImportedModel: mocks.upsertImportedModel,
    withQueuedImportedModelReservation: mocks.withQueuedImportedModelReservation,
    findImportedModel: mocks.findImportedModel,
  };
});
vi.mock("@/lib/server/hf-import-url", () => ({
  resolveHuggingFaceModelFileUrl: mocks.resolveHuggingFaceModelFileUrl,
}));

import { POST } from "@/app/api/desktop-runtime/models/import/route";

function importRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/desktop-runtime/models/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireDesktopBridge.mockReturnValue({ url: "http://127.0.0.1:9", token: "t" });
  mocks.findImportedModel.mockResolvedValue(undefined);
  mocks.probeBridgeDownloadJob.mockResolvedValue({ outcome: "not_found", jobId: "missing" });
  mocks.resolveHuggingFaceModelFileUrl.mockReturnValue({
    url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
    fileName: "demo.gguf",
  });
  mocks.upsertImportedModel.mockImplementation(async (record) => record);
  mocks.withQueuedImportedModelReservation.mockImplementation(
    async ({ record, start }) => ({ record, result: await start() }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(null, {
        status: 200,
        headers: { "x-linked-etag": `"${"a".repeat(64)}"` },
      }),
    ),
  );
});

describe("desktop model import route compensation", () => {
  it("persists queued before bridge start and compensates launch failure", async () => {
    const order: string[] = [];
    mocks.withQueuedImportedModelReservation.mockImplementation(async ({ record, start }) => {
      order.push("queue");
      try {
        return { record, result: await start() };
      } catch (error) {
        order.push("compensate");
        throw error;
      }
    });
    mocks.startBridgeDownloadJob.mockImplementation(async () => {
      order.push("bridge");
      return new Response("boom", { status: 503 });
    });
    mocks.bridgeErrorText.mockResolvedValue("boom");
    const response = await POST(
      importRequest({
        source: "huggingface-url",
        url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
        runtimeTarget: "llama-cpp",
      }),
    );

    expect(response.status).toBe(503);
    expect(order).toEqual(["queue", "bridge", "compensate"]);
    expect(mocks.withQueuedImportedModelReservation).toHaveBeenCalled();
  });

  it("keeps the queued record when bridge start succeeds", async () => {
    mocks.startBridgeDownloadJob.mockResolvedValue(new Response(null, { status: 200 }));

    const response = await POST(
      importRequest({
        source: "huggingface-url",
        url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
        runtimeTarget: "llama-cpp",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.withQueuedImportedModelReservation).toHaveBeenCalledWith(
      expect.objectContaining({ record: expect.objectContaining({ status: "queued" }) }),
    );
  });

  it("adopts an existing queued owner with the original job id and payload when status is unavailable", async () => {
    mocks.findImportedModel.mockImplementation(async () => ({
      id: "existing-model",
      jobId: "existing-job",
      status: "queued",
      source: "huggingface-url",
      fileName: "demo.gguf",
      runtimeTarget: "llama-cpp",
      modelPath: (await import("@/lib/server/imported-model-registry")).importedModelDownloadDest(
        "llama-cpp",
        (await import("@/lib/server/imported-model-registry")).importedModelId(
          "llama-cpp",
          "demo.gguf",
          "https://huggingface.co/org/model/resolve/main/demo.gguf",
        ),
        "demo.gguf",
      ),
      url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
      sha256: "b".repeat(64),
    }));
    mocks.probeBridgeDownloadJob.mockResolvedValue({ outcome: "not_found", jobId: "existing-job" });
    mocks.startBridgeDownloadJob.mockResolvedValue(new Response(null, { status: 200 }));

    const response = await POST(
      importRequest({
        source: "huggingface-url",
        url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
        runtimeTarget: "llama-cpp",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      queued: true,
      reused: true,
      recovered: true,
      jobId: "existing-job",
    });
    expect(mocks.withQueuedImportedModelReservation).not.toHaveBeenCalled();
    expect(mocks.startBridgeDownloadJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jobId: "existing-job",
        url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
        sha256: "b".repeat(64),
      }),
    );
  });

  it("does not retry an existing queued owner while its status probe is ambiguous", async () => {
    mocks.findImportedModel.mockResolvedValue({
      id: "existing-model",
      jobId: "existing-job",
      status: "queued",
      source: "huggingface-url",
      fileName: "demo.gguf",
      runtimeTarget: "llama-cpp",
      modelPath: "/models/demo.gguf",
      url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
      sha256: "b".repeat(64),
    });
    mocks.probeBridgeDownloadJob.mockResolvedValue({
      outcome: "ambiguous",
      jobId: "existing-job",
      code: "bridge_timeout",
    });

    const response = await POST(
      importRequest({
        source: "huggingface-url",
        url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
        runtimeTarget: "llama-cpp",
      }),
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      code: "bridge_timeout",
      partialState: true,
      queued: true,
      jobId: "existing-job",
    });
    expect(mocks.startBridgeDownloadJob).not.toHaveBeenCalled();
    expect(mocks.withQueuedImportedModelReservation).not.toHaveBeenCalled();
  });

  it("keeps queued ownership when start response is lost but status finds the job", async () => {
    mocks.startBridgeDownloadJob.mockRejectedValue(new Error("socket closed after write"));
    mocks.probeBridgeDownloadJob.mockResolvedValue({
      outcome: "observed",
      jobId: "accepted-job",
      status: "downloading",
      body: { status: "downloading" },
    });

    const response = await POST(
      importRequest({
        source: "huggingface-url",
        url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
        runtimeTarget: "llama-cpp",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.probeBridgeDownloadJob).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.any(String) }),
      expect.any(String),
    );
  });

  it("reports unknown partial state and preserves queued ownership when status is unavailable", async () => {
    mocks.startBridgeDownloadJob.mockRejectedValue(new Error("socket closed after write"));
    mocks.probeBridgeDownloadJob.mockResolvedValue({ outcome: "not_found", jobId: "missing" });

    const response = await POST(
      importRequest({
        source: "huggingface-url",
        url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
        runtimeTarget: "llama-cpp",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "bridge_start_unknown",
      partialState: true,
      queued: true,
      retryable: true,
    });
  });

  it("reports a retryable queued state when the post-timeout status probe also times out", async () => {
    mocks.startBridgeDownloadJob.mockRejectedValue(
      Object.assign(new Error("bridge start timed out"), { name: "TimeoutError" }),
    );
    mocks.probeBridgeDownloadJob.mockResolvedValue({
      outcome: "ambiguous",
      jobId: "timed-out-job",
      code: "bridge_timeout",
    });

    const response = await POST(
      importRequest({
        source: "huggingface-url",
        url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
        runtimeTarget: "llama-cpp",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "bridge_start_unknown",
      partialState: true,
      queued: true,
      retryable: true,
    });
  });

  it("keeps queued ownership when the worker appears after an immediate unknown probe", async () => {
    const order: string[] = [];
    let releaseWorker!: () => void;
    const workerMayStart = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const workerStarted = workerMayStart.then(() => {
      order.push("worker-started");
    });
    mocks.withQueuedImportedModelReservation.mockImplementation(async ({ record, start }) => {
      order.push("queued");
      try {
        return { record, result: await start() };
      } catch (error) {
        const registry = await import("@/lib/server/imported-model-registry");
        if (!(error instanceof registry.QueuedImportedModelStartUncertainError)) {
          order.push("compensated");
        }
        throw error;
      }
    });
    mocks.startBridgeDownloadJob.mockImplementation(async () => {
      order.push("start-request-sent");
      throw new Error("response lost");
    });
    mocks.probeBridgeDownloadJob.mockImplementation(async () => {
      order.push("probe-unknown");
      return { outcome: "not_found", jobId: "missing" };
    });

    const response = await POST(
      importRequest({
        source: "huggingface-url",
        url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
        runtimeTarget: "llama-cpp",
      }),
    );
    releaseWorker();
    await workerStarted;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "bridge_start_unknown",
      partialState: true,
      queued: true,
    });
    expect(order).toEqual([
      "queued",
      "start-request-sent",
      "probe-unknown",
      "worker-started",
    ]);
  });

  it("returns bridge unavailable when the desktop bridge is missing", async () => {
    mocks.requireDesktopBridge.mockReturnValue(
      NextResponse.json({ error: "Desktop runtime bridge is not available" }, { status: 404 }),
    );

    const response = await POST(
      importRequest({
        source: "huggingface-url",
        url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
        runtimeTarget: "llama-cpp",
      }),
    );

    expect(response.status).toBe(404);
    expect(mocks.withQueuedImportedModelReservation).not.toHaveBeenCalled();
  });

  it("restores an existing record when bridge start fails", async () => {
    const previous = {
      id: "prior",
      jobId: undefined,
      status: "ready",
    };
    mocks.findImportedModel.mockResolvedValue(previous);
    mocks.startBridgeDownloadJob.mockResolvedValue(new Response("boom", { status: 503 }));
    mocks.bridgeErrorText.mockResolvedValue("boom");

    const response = await POST(
      importRequest({
        source: "huggingface-url",
        url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
        runtimeTarget: "llama-cpp",
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.withQueuedImportedModelReservation).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPrevious: previous }),
    );
  });

  it("reports explicit partial state when bridge compensation fails", async () => {
    const { ApiError } = await import("@/lib/server/errors");
    mocks.withQueuedImportedModelReservation.mockRejectedValue(new ApiError({
      status: 500,
      code: "imported_model_registry_compensation_failed",
      message: "registry rollback failed",
      retryable: false,
    }));

    const response = await POST(
      importRequest({
        source: "huggingface-url",
        url: "https://huggingface.co/org/model/resolve/main/demo.gguf",
        runtimeTarget: "llama-cpp",
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: "imported_model_registry_compensation_failed",
      partialState: true,
    });
  });
});
