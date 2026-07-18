import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/client/fetch-json";
import {
  createPreparingProgress,
  estimateSdRemainingSeconds,
  isRequestAbortedError,
  pollSdProgress,
  requestSdCancellation,
  sdProgressPercent,
} from "@/lib/client/sd-progress";
import type { SdProgress } from "@/lib/types/sd-progress";

function samplingProgress(overrides: Partial<SdProgress> = {}): SdProgress {
  return {
    runId: "run-1",
    phase: "sampling",
    currentImage: 1,
    totalImages: 2,
    step: 7,
    totalSteps: 28,
    secondsPerStep: 2,
    startedAtMs: 100,
    updatedAtMs: 200,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sd progress presentation", () => {
  it("uses native step speed for percent and multi-image ETA", () => {
    const progress = samplingProgress();
    expect(sdProgressPercent(progress)).toBe(25);
    expect(estimateSdRemainingSeconds(progress)).toBe((21 + 28) * 2);
  });

  it("does not invent progress before native sampling starts", () => {
    const progress = createPreparingProgress("run-1", 2);
    expect(progress).toMatchObject({
      phase: "preparing",
      currentImage: 1,
      totalImages: 2,
      step: null,
      totalSteps: null,
      secondsPerStep: null,
    });
    expect(sdProgressPercent(progress)).toBeNull();
    expect(estimateSdRemainingSeconds(progress)).toBeNull();
  });

  it("isolates polling updates by runId and stops at a terminal phase", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ progress: samplingProgress({ runId: "run-other" }) })
      .mockResolvedValueOnce({ progress: samplingProgress() })
      .mockResolvedValueOnce({ progress: samplingProgress({ phase: "completed" }) });
    const onProgress = vi.fn();

    await pollSdProgress({
      runId: "run-1",
      signal: new AbortController().signal,
      onProgress,
      intervalMs: 0,
      read,
    });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0]?.[0]).toMatchObject({ runId: "run-1", phase: "sampling" });
    expect(onProgress.mock.calls[1]?.[0]).toMatchObject({ runId: "run-1", phase: "completed" });
  });

  it("recognizes both browser aborts and request_aborted API responses", () => {
    expect(isRequestAbortedError(new DOMException("Aborted", "AbortError"))).toBe(true);
    expect(
      isRequestAbortedError(
        new HttpError("cancelled", {
          status: 499,
          statusText: "Client Closed Request",
          payload: { code: "request_aborted" },
        }),
      ),
    ).toBe(true);
  });

  it("does not report cancellation until the native bridge acknowledges it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ canceled: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(requestSdCancellation("run-1")).rejects.toThrow(
      "Native image generation did not stop",
    );
  });

  it("surfaces cancellation transport failures instead of swallowing them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("bridge offline")));

    await expect(requestSdCancellation("run-1")).rejects.toThrow("bridge offline");
  });
});
