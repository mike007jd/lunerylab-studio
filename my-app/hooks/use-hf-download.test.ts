import { describe, expect, it, vi } from "vitest";
import {
  HfDownloadCancelCoordinator,
  resolveHfDownloadStartOwnership,
} from "@/lib/client/hf-download-progress";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Hook-level ownership contract tests.
 *
 * The hook itself is a thin React wrapper around these helpers: generate a
 * client UUID, registerJob before await, and never route ambiguous ownership
 * through failJobRequest/local-canceled.
 */
describe("useHfDownload client-preassigned ownership", () => {
  it("registers the known jobId before the start await and cancels it if the response is lost", async () => {
    const calls: string[] = [];
    let resolveStart!: (value: never) => void;
    const startHang = new Promise<Response>((_resolve, reject) => {
      resolveStart = reject as (value: never) => void;
    });

    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/hf-download")) {
        calls.push("start");
        return startHang;
      }
      if (init?.method === "DELETE") {
        calls.push("cancel");
        return jsonResponse({ ok: true, cancelRequested: true, jobId: "job-hook" });
      }
      calls.push("status");
      return jsonResponse({ status: "canceled", received: 0, total: 1, error: null });
    });

    const coordinator = new HfDownloadCancelCoordinator(fetcher, async () => {});
    expect(coordinator.prepareJobRequest()).toBe(true);
    const jobId = "job-hook";
    // Mirror the hook: register before any network await.
    coordinator.registerJob(jobId);

    const cancelPromise = coordinator.requestCancel();
    await Promise.resolve();
    expect(calls).toContain("cancel");

    resolveStart!(new TypeError("POST response lost after bridge accept") as never);

    const startOutcome = await resolveHfDownloadStartOwnership(
      { modelId: "qwen3.6-35b-a3b-ud-q4-k-m", jobId },
      { fetcher, retryIdempotentStart: false },
    );
    // Lost response stays non-terminal; cancel uses the known id rather than
    // failJobRequest → local canceled.
    expect(startOutcome.kind).not.toBe("rejected");
    await expect(cancelPromise).resolves.toMatchObject({ status: "canceled" });
    expect(calls[0]).toBe("cancel");
  });

  it("does not call failJobRequest semantics for ambiguous ownership", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("socket closed after write");
    });
    const coordinator = new HfDownloadCancelCoordinator(fetcher, async () => {});
    coordinator.prepareJobRequest();
    coordinator.registerJob("job-no-fail");

    const outcome = await resolveHfDownloadStartOwnership(
      { modelId: "qwen3.6-35b-a3b-ud-q4-k-m", jobId: "job-no-fail" },
      { fetcher, retryIdempotentStart: false },
    );

    expect(outcome).toMatchObject({ kind: "ambiguous", jobId: "job-no-fail" });
    // Ownership remains registered — a subsequent cancel still targets job-no-fail
    // instead of resolving the pending waiter as null/local-canceled.
    const cancelFetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, cancelRequested: true, jobId: "job-no-fail" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status: "canceled", received: 0, total: 1, error: null }),
      );
    const owned = new HfDownloadCancelCoordinator(cancelFetcher, async () => {});
    owned.prepareJobRequest();
    owned.registerJob("job-no-fail");
    // Simulate the ambiguous path: finishJob/failJobRequest are NOT called.
    await expect(owned.requestCancel()).resolves.toMatchObject({ status: "canceled" });
    expect(cancelFetcher).toHaveBeenCalledWith(
      "/api/desktop-runtime/hf-download/job-no-fail",
      { method: "DELETE", cache: "no-store" },
    );
  });

  it("includes the client jobId in the public start route body", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ jobId: "job-body" }));
    await resolveHfDownloadStartOwnership(
      {
        modelId: "qwen3.6-35b-a3b-ud-q4-k-m",
        jobId: "job-body",
        file: "companion.safetensors",
      },
      { fetcher, retryIdempotentStart: false },
    );

    expect(fetcher).toHaveBeenCalledWith(
      "/api/desktop-runtime/hf-download",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          modelId: "qwen3.6-35b-a3b-ud-q4-k-m",
          file: "companion.safetensors",
          jobId: "job-body",
        }),
      }),
    );
  });
});
