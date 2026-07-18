import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestWriteQueue } from "@/components/canvas/latest-write-queue";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createLatestWriteQueue", () => {
  it("serializes writes and coalesces queued values to the latest", async () => {
    const first = deferred();
    const writes: string[] = [];
    const write = vi.fn(async (value: string) => {
      writes.push(value);
      if (value === "first") await first.promise;
    });
    const saved = vi.fn();
    const queue = createLatestWriteQueue({
      write,
      maxRetries: 2,
      retryDelayMs: () => 1,
      onLatestSaved: saved,
    });

    queue.enqueue("first");
    queue.enqueue("second");
    queue.enqueue("latest");
    expect(writes).toEqual(["first"]);

    first.resolve();
    await vi.waitFor(() => expect(writes).toEqual(["first", "latest"]));
    expect(saved).toHaveBeenCalledOnce();
    expect(saved).toHaveBeenCalledWith("latest");
  });

  it("retries the latest failed value", async () => {
    vi.useFakeTimers();
    const write = vi
      .fn<(value: string) => Promise<void>>()
      .mockImplementationOnce(async () => {
        throw new Error("offline");
      })
      .mockImplementationOnce(async () => {});
    const exhausted = vi.fn();
    const queue = createLatestWriteQueue({
      write,
      maxRetries: 2,
      retryDelayMs: () => 10,
      onExhausted: exhausted,
    });

    queue.enqueue("latest");
    await vi.advanceTimersByTimeAsync(10);
    expect(write).toHaveBeenCalledTimes(2);
    expect(exhausted).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("reports one terminal failure after the retry budget", async () => {
    vi.useFakeTimers();
    const exhausted = vi.fn();
    const queue = createLatestWriteQueue({
      write: vi.fn(async () => {
        throw new Error("offline");
      }),
      maxRetries: 1,
      retryDelayMs: () => 10,
      onExhausted: exhausted,
    });

    queue.enqueue("latest");
    await vi.advanceTimersByTimeAsync(10);
    expect(exhausted).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("merges a failed partial write into newer pending fields before retrying", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const writes: Array<Record<string, number>> = [];
    const queue = createLatestWriteQueue<Record<string, number>>({
      write: async (value) => {
        writes.push(value);
        if (writes.length === 1) await first.promise;
      },
      mergePending: (older, newer) => ({ ...older, ...newer }),
      maxRetries: 1,
      retryDelayMs: () => 10,
    });

    queue.enqueue({ x: 1 });
    queue.enqueue({ y: 2 });
    queue.enqueue({ x: 3 });
    first.reject(new Error("offline"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    expect(writes).toEqual([{ x: 1 }, { x: 3, y: 2 }]);
    vi.useRealTimers();
  });

  it("limits close to one final flush and detaches callbacks", async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const exhausted = vi.fn();
    const write = vi.fn(async () => {
      throw new Error("offline");
    });
    const queue = createLatestWriteQueue({
      write,
      maxRetries: 2,
      retryDelayMs: () => 10,
      onSettled: settled,
      onExhausted: exhausted,
    });

    queue.enqueue("latest");
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();

    queue.close();
    queue.enqueue("ignored");
    await vi.advanceTimersByTimeAsync(100);

    expect(write).toHaveBeenCalledTimes(2);
    expect(exhausted).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("drains one latest queued value after an active write closes", async () => {
    const first = deferred();
    const writes: string[] = [];
    const latestSaved = vi.fn();
    const queue = createLatestWriteQueue({
      write: async (value: string) => {
        writes.push(value);
        if (value === "first") await first.promise;
      },
      maxRetries: 2,
      retryDelayMs: () => 10,
      onLatestSaved: latestSaved,
    });

    queue.enqueue("first");
    queue.enqueue("latest");
    queue.close();
    first.resolve();
    await vi.waitFor(() => expect(writes).toEqual(["first", "latest"]));

    expect(latestSaved).not.toHaveBeenCalled();
  });

  it("attempts the queued latest value once when the active write fails after close", async () => {
    const first = deferred();
    const writes: string[] = [];
    const queue = createLatestWriteQueue({
      write: async (value: string) => {
        writes.push(value);
        if (value === "first") await first.promise;
      },
      maxRetries: 2,
      retryDelayMs: () => 10,
    });

    queue.enqueue("first");
    queue.enqueue("latest");
    queue.close();
    first.reject(new Error("offline"));

    await vi.waitFor(() => expect(writes).toEqual(["first", "latest"]));
  });

  it("flushes through retries and reports the terminal outcome", async () => {
    const write = vi
      .fn<(value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce();
    const queue = createLatestWriteQueue({
      write,
      maxRetries: 1,
      retryDelayMs: () => 0,
    });

    queue.enqueue("latest");
    await expect(queue.flush()).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(2);

    const failed = createLatestWriteQueue({
      write: vi.fn(async () => {
        throw new Error("offline");
      }),
      maxRetries: 0,
      retryDelayMs: () => 0,
    });
    failed.enqueue("latest");
    await expect(failed.flush()).resolves.toBe(false);
  });

  it("aborts a stalled write and resolves flush after the write timeout", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const queue = createLatestWriteQueue({
        write: (_value: string, signal: AbortSignal) => {
          observedSignal = signal;
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        maxRetries: 0,
        retryDelayMs: () => 0,
        writeTimeoutMs: 100,
      });

      queue.enqueue("latest");
      let outcome: boolean | undefined;
      void queue.flush().then((value) => {
        outcome = value;
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(observedSignal?.aborted).toBe(true);
      expect(outcome).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
