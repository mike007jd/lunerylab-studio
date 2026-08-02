// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHfDownload } from "@/hooks/use-hf-download";
import {
  HfDownloadCancelCoordinator,
  resolveHfDownloadStartOwnership,
} from "@/lib/client/hf-download-progress";

const CANONICAL_JOB_ID = "11111111-1111-4111-8111-111111111111";
const MODEL_ID = "qwen3.6-35b-a3b-ud-q4-k-m";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type HfDownloadApi = ReturnType<typeof useHfDownload>;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/**
 * Hook-level ownership contract tests.
 *
 * Helpers below document the register-before-await contract. The mounted
 * React harness is the authority that the real hook keeps that contract.
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
      { modelId: MODEL_ID, jobId },
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
      { modelId: MODEL_ID, jobId: "job-no-fail" },
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
        modelId: MODEL_ID,
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
          modelId: MODEL_ID,
          file: "companion.safetensors",
          jobId: "job-body",
        }),
      }),
    );
  });
});

describe("useHfDownload mounted ownership harness", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: HfDownloadApi | null;
  let fetchMock: ReturnType<typeof vi.fn>;
  let deleteSeen = false;
  let eventSourceOpened = 0;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
    deleteSeen = false;
    eventSourceOpened = 0;

    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(CANONICAL_JOB_ID);

    class StubEventSource {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string) {
        eventSourceOpened += 1;
        throw new Error(`EventSource must not open during ambiguous ownership: ${url}`);
      }
      close() {}
    }
    vi.stubGlobal("EventSource", StubEventSource);

    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "POST" && url.endsWith("/hf-download")) {
        // Public start accepted on the wire, but the response never returns.
        throw new TypeError("POST response lost after bridge accept");
      }

      if (method === "DELETE" && url.endsWith(`/hf-download/${CANONICAL_JOB_ID}`)) {
        deleteSeen = true;
        return jsonResponse({
          ok: true,
          cancelRequested: true,
          jobId: CANONICAL_JOB_ID,
        });
      }

      if (url.endsWith(`/hf-download/${CANONICAL_JOB_ID}`)) {
        if (deleteSeen) {
          return jsonResponse({
            status: "canceled",
            received: 0,
            total: 1,
            error: null,
          });
        }
        // Ownership GET stays ambiguous/non-terminal after the lost start.
        throw new TypeError("ownership status temporarily unavailable");
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    latest = null;
  });

  it("keeps queued ownership under the preassigned UUID and cancels by that id after a lost start", async () => {
    function Probe() {
      latest = useHfDownload();
      return null;
    }

    await act(async () => {
      root.render(createElement(Probe));
    });
    expect(latest).not.toBeNull();

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = latest!.start(MODEL_ID);
      await startPromise;
    });

    expect(eventSourceOpened).toBe(0);
    expect(latest!.jobId).toBe(CANONICAL_JOB_ID);
    expect(latest!.status).toBe("queued");
    expect(latest!.status).not.toBe("error");
    expect(latest!.status).not.toBe("canceled");
    expect(latest!.status).not.toBe("idle");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/desktop-runtime/hf-download",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ modelId: MODEL_ID, jobId: CANONICAL_JOB_ID }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/desktop-runtime/hf-download/${CANONICAL_JOB_ID}`,
      { cache: "no-store" },
    );

    let cancelPromise!: Promise<void>;
    await act(async () => {
      cancelPromise = latest!.cancel();
      await cancelPromise;
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/desktop-runtime/hf-download/${CANONICAL_JOB_ID}`,
      { method: "DELETE", cache: "no-store" },
    );
    expect(latest!.status).toBe("canceled");
    expect(latest!.jobId).toBe(CANONICAL_JOB_ID);
    expect(eventSourceOpened).toBe(0);
  });
});
