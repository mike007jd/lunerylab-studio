import { describe, expect, it, vi } from "vitest";
import {
  HfDownloadCancelCoordinator,
  measureDownloadSpeed,
  normalizeDownloadStatus,
  probeHfDownloadOwnership,
  requestHfDownloadCancel,
  requestHfDownloadStart,
  reduceBridgeDownloadSnapshot,
  resolveHfDownloadKit,
  resolveHfDownloadStartOwnership,
  waitForHfDownloadTerminal,
} from "./hf-download-progress";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("hf-download progress helpers", () => {
  it("normalizes unknown bridge statuses without throwing away progress data", () => {
    expect(normalizeDownloadStatus("downloading")).toBe("downloading");
    expect(normalizeDownloadStatus("bridge-added-a-status")).toBe("unknown");
  });

  it("resolves single-file model kits without forcing a companion file param", () => {
    const kit = resolveHfDownloadKit("qwen3.6-35b-a3b-ud-q4-k-m");

    expect(kit.multi).toBe(false);
    expect(kit.files).toHaveLength(1);
    expect(kit.files[0]?.name).toBe("Qwen3.6-35B-A3B-UD-Q4_K_M.gguf");
    expect(kit.total).toBeGreaterThan(0);
  });

  it("resolves companion model kits with the main file first", () => {
    const kit = resolveHfDownloadKit("flux2-dev-q4");

    expect(kit.multi).toBe(true);
    expect(kit.files.map((file) => file.name)).toEqual([
      "flux2-dev-Q4_K_M.gguf",
      "full_encoder_small_decoder.safetensors",
      "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
    ]);
    expect(kit.files.reduce((sum, file) => sum + file.size, 0)).toBe(kit.total);
  });

  it("keeps single-file progress indeterminate when the bridge has no total", () => {
    const kit = resolveHfDownloadKit("qwen3.6-35b-a3b-ud-q4-k-m");
    const reduced = reduceBridgeDownloadSnapshot({
      snapshot: { status: "downloading", received: 200, total: 0, error: null },
      previousSpeedSample: null,
      completedBytes: 0,
      fileIndex: 0,
      jobId: "job-1",
      kit,
      timestamp: 1_000,
    });

    expect(reduced.progress).toMatchObject({
      status: "downloading",
      percent: null,
      received: 200,
      total: 0,
      speedBps: 0,
      jobId: "job-1",
      fileIndex: 0,
      fileCount: 1,
    });
    expect(reduced.terminalStatus).toBeNull();
  });

  it("aggregates companion-kit progress against the whole kit total", () => {
    const kit = {
      multi: true,
      total: 1_000,
      files: [
        { name: "main", size: 700 },
        { name: "decoder", size: 300 },
      ],
    };
    const reduced = reduceBridgeDownloadSnapshot({
      snapshot: { status: "ready", received: 150, total: 300, error: null },
      previousSpeedSample: { received: 50, timestamp: 1_000 },
      completedBytes: 700,
      fileIndex: 1,
      jobId: "job-2",
      kit,
      timestamp: 3_000,
    });

    expect(reduced.progress).toMatchObject({
      status: "ready",
      percent: 85,
      received: 850,
      total: 1_000,
      speedBps: 50,
      fileIndex: 1,
      fileCount: 2,
    });
    expect(reduced.terminalStatus).toBe("ready");
  });

  it("clamps negative speed samples to zero", () => {
    expect(measureDownloadSpeed({ received: 200, timestamp: 1_000 }, 100, 2_000)).toMatchObject({
      speedBps: 0,
      speedSample: { received: 100, timestamp: 2_000 },
    });
  });

  it("requires the desktop runtime's typed cancel acknowledgment", async () => {
    const accepted = vi.fn(async () =>
      jsonResponse({ ok: true, cancelRequested: true, jobId: "job-ack" }),
    );
    await expect(requestHfDownloadCancel("job-ack", accepted)).resolves.toBeUndefined();
    expect(accepted).toHaveBeenCalledWith(
      "/api/desktop-runtime/hf-download/job-ack",
      { method: "DELETE", cache: "no-store" },
    );

    const rejected = vi.fn(async () => jsonResponse({ error: "busy" }, 429));
    await expect(requestHfDownloadCancel("job-ack", rejected)).rejects.toThrow(
      "Cancel request failed",
    );

    const falseAck = vi.fn(async () =>
      jsonResponse({ ok: true, cancelRequested: false, jobId: "job-ack" }),
    );
    await expect(requestHfDownloadCancel("job-ack", falseAck)).rejects.toThrow(
      "was not acknowledged",
    );
  });

  it("waits through active and transient status reads for server terminal truth", async () => {
    const responses: Array<Response | Error> = [
      new Error("temporary bridge disconnect"),
      jsonResponse({ status: "downloading", received: 5, total: 10, error: null }),
      jsonResponse({ status: "canceled", received: 5, total: 10, error: null }),
    ];
    const fetcher = vi.fn(async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error("unexpected status request");
      return response;
    });
    const sleep = vi.fn(async () => {});

    await expect(
      waitForHfDownloadTerminal("job-poll", {
        fetcher,
        sleep,
        pollIntervalMs: 1,
        maxAttempts: 3,
      }),
    ).resolves.toMatchObject({ status: "canceled", received: 5 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it.each(["ready", "error"] as const)(
    "preserves a server %s terminal result after cancel acknowledgment",
    async (terminalStatus) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ ok: true, cancelRequested: true, jobId: "job-terminal" }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            status: terminalStatus,
            received: 10,
            total: 10,
            error: terminalStatus === "error" ? "checksum failed" : null,
          }),
        );
      const coordinator = new HfDownloadCancelCoordinator(fetcher, async () => {});
      expect(coordinator.prepareJobRequest()).toBe(true);
      coordinator.registerJob("job-terminal");

      await expect(coordinator.requestCancel()).resolves.toMatchObject({
        status: terminalStatus,
        snapshot: { status: terminalStatus },
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("waits for a pending start POST job id before issuing DELETE", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, cancelRequested: true, jobId: "job-pending" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status: "downloading", received: 1, total: 10, error: null }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status: "canceled", received: 1, total: 10, error: null }),
      );
    const coordinator = new HfDownloadCancelCoordinator(fetcher, async () => {});
    expect(coordinator.prepareJobRequest()).toBe(true);

    const cancel = coordinator.requestCancel();
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();

    coordinator.registerJob("job-pending");
    await expect(cancel).resolves.toMatchObject({ status: "canceled" });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/desktop-runtime/hf-download/job-pending",
      { method: "DELETE", cache: "no-store" },
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("restores retryable state after a failed acknowledgment", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "not accepted" }, 409))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, cancelRequested: true, jobId: "job-retry" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status: "canceled", received: 2, total: 10, error: null }),
      );
    const coordinator = new HfDownloadCancelCoordinator(fetcher, async () => {});
    coordinator.prepareJobRequest();
    coordinator.registerJob("job-retry");

    await expect(coordinator.requestCancel()).rejects.toThrow("Cancel request failed");
    expect(coordinator.cancelRequested).toBe(false);
    await expect(coordinator.requestCancel()).resolves.toMatchObject({ status: "canceled" });
  });

  it("restores retryable state when the DELETE transport rejects", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("bridge connection reset"))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, cancelRequested: true, jobId: "job-transport-retry" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status: "canceled", received: 3, total: 10, error: null }),
      );
    const coordinator = new HfDownloadCancelCoordinator(fetcher, async () => {});
    coordinator.prepareJobRequest();
    coordinator.registerJob("job-transport-retry");

    await expect(coordinator.requestCancel()).rejects.toThrow("bridge connection reset");
    expect(coordinator.cancelRequested).toBe(false);
    await expect(coordinator.requestCancel()).resolves.toMatchObject({ status: "canceled" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("cancels locally between multi-file jobs without creating another server request", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("no bridge request expected between files");
    });
    const coordinator = new HfDownloadCancelCoordinator(fetcher, async () => {});
    coordinator.prepareJobRequest();
    coordinator.registerJob("kit-file-1");
    coordinator.finishJob("kit-file-1");

    await expect(coordinator.requestCancel()).resolves.toEqual({
      status: "canceled",
      snapshot: null,
    });
    expect(coordinator.prepareJobRequest()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats a lost start response as ambiguous ownership under the known jobId", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("network connection lost after write");
    });

    await expect(
      requestHfDownloadStart(
        { modelId: "qwen3.6-35b-a3b-ud-q4-k-m", jobId: "job-lost" },
        fetcher,
      ),
    ).resolves.toEqual({
      kind: "ambiguous",
      jobId: "job-lost",
      code: "bridge_start_unknown",
      error: "network connection lost after write",
    });
  });

  it("recovers lost start ownership when a later status probe observes the job", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("response lost after accept"))
      .mockResolvedValueOnce(
        jsonResponse({ status: "downloading", received: 1, total: 10, error: null }),
      );

    await expect(
      resolveHfDownloadStartOwnership(
        { modelId: "qwen3.6-35b-a3b-ud-q4-k-m", jobId: "job-recovered" },
        { fetcher, retryIdempotentStart: false },
      ),
    ).resolves.toEqual({ kind: "accepted", jobId: "job-recovered" });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/desktop-runtime/hf-download/job-recovered",
      { cache: "no-store" },
    );
  });

  it("cancels with the preassigned jobId during an ambiguous start", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, cancelRequested: true, jobId: "job-ambiguous" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status: "canceled", received: 0, total: 10, error: null }),
      );
    const coordinator = new HfDownloadCancelCoordinator(fetcher, async () => {});
    expect(coordinator.prepareJobRequest()).toBe(true);
    // Ownership is registered before the start await, matching the hook contract.
    coordinator.registerJob("job-ambiguous");

    const cancel = coordinator.requestCancel();
    await expect(cancel).resolves.toMatchObject({ status: "canceled" });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/desktop-runtime/hf-download/job-ambiguous",
      { method: "DELETE", cache: "no-store" },
    );
    // failJobRequest must not collapse known ownership into local-canceled.
    coordinator.failJobRequest();
    expect(coordinator.activeCancelAttempt()).toBeNull();
  });

  it("retries an idempotent same-ID start after a missing status probe", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: "Desktop runtime bridge timed out",
            code: "bridge_timeout",
            jobId: "job-retry",
            retryable: true,
            partialState: true,
          },
          504,
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ jobId: "job-retry", dest: "/models/x" }));

    await expect(
      resolveHfDownloadStartOwnership(
        { modelId: "qwen3.6-35b-a3b-ud-q4-k-m", jobId: "job-retry" },
        { fetcher },
      ),
    ).resolves.toEqual({ kind: "accepted", jobId: "job-retry" });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/desktop-runtime/hf-download",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          modelId: "qwen3.6-35b-a3b-ud-q4-k-m",
          jobId: "job-retry",
        }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "/api/desktop-runtime/hf-download",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          modelId: "qwen3.6-35b-a3b-ud-q4-k-m",
          jobId: "job-retry",
        }),
      }),
    );
  });

  it("treats a definitive start rejection as terminal and non-retryable ownership loss", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(
        { error: "Bridge start failed: conflict", jobId: "job-reject", retryable: false },
        409,
      ),
    );

    await expect(
      requestHfDownloadStart(
        { modelId: "qwen3.6-35b-a3b-ud-q4-k-m", jobId: "job-reject" },
        fetcher,
      ),
    ).resolves.toEqual({
      kind: "rejected",
      jobId: "job-reject",
      status: 409,
      error: "Bridge start failed: conflict",
    });
  });

  it("keeps status probe transport loss ambiguous instead of missing", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("status server never responded");
    });

    await expect(probeHfDownloadOwnership("job-status-hang", fetcher)).resolves.toEqual({
      kind: "ambiguous",
      jobId: "job-status-hang",
      error: "status server never responded",
    });
  });
});
