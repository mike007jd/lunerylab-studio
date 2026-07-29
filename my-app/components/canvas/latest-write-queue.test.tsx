import { describe, expect, it, vi } from "vitest";
import { createLatestWriteQueue } from "@/components/canvas/latest-write-queue";
import {
  CanvasLayerLockedError,
  isCanvasLayerLockedError,
} from "@/lib/client/canvas-sessions";

describe("createLatestWriteQueue non-retryable errors", () => {
  it("does not retry canvas_layer_locked and exhausts immediately", async () => {
    const write = vi.fn(async () => {
      throw new CanvasLayerLockedError();
    });
    const onExhausted = vi.fn();
    const queue = createLatestWriteQueue({
      write,
      maxRetries: 4,
      retryDelayMs: () => 0,
      isNonRetryableError: isCanvasLayerLockedError,
      onExhausted,
    });

    queue.enqueue({ patch: { x: 1 } });
    await vi.waitFor(() => expect(onExhausted).toHaveBeenCalledTimes(1));

    expect(write).toHaveBeenCalledTimes(1);
    await expect(queue.flush()).resolves.toBe(false);
  });
});
