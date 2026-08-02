import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BridgeDownloadControlError,
  probeBridgeDownloadJob,
  startBridgeDownloadJob,
} from "@/lib/server/desktop-bridge";

const bridge = { url: "http://127.0.0.1:49152", token: "dev-token" };
const JOB_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bridge download control deadlines", () => {
  it("fails start with typed timeout when the start server never responds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const onAbort = () => {
            const reason = signal.reason;
            if (reason instanceof Error) reject(reason);
            else {
              const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
                name: "TimeoutError",
              });
              reject(timeout);
            }
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      }),
    );

    const pending = startBridgeDownloadJob(
      bridge,
      {
        url: "https://example.com/model.gguf",
        dest: "/models/model.gguf",
        sha256: null,
        jobId: JOB_ID,
      },
      { timeoutMs: 25 },
    );
    const expectation = expect(pending).rejects.toMatchObject({
      name: "BridgeDownloadControlError",
      code: "bridge_timeout",
      retryable: true,
      jobId: JOB_ID,
    });
    await vi.advanceTimersByTimeAsync(30);
    await expectation;
  });

  it("returns ambiguous probe when the status server never responds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const onAbort = () => {
            const reason = signal.reason;
            if (reason instanceof Error) reject(reason);
            else {
              reject(
                Object.assign(new Error("The operation was aborted due to timeout"), {
                  name: "TimeoutError",
                }),
              );
            }
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      }),
    );

    const pending = probeBridgeDownloadJob(bridge, JOB_ID, { timeoutMs: 25 });
    const expectation = expect(pending).resolves.toMatchObject({
      outcome: "ambiguous",
      jobId: JOB_ID,
      code: "bridge_timeout",
    });
    await vi.advanceTimersByTimeAsync(30);
    await expectation;
  });

  it("does not overwrite a caller abort signal on start", async () => {
    const caller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const onAbort = () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : Object.assign(new Error("Aborted"), { name: "AbortError" }),
            );
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      }),
    );

    const pending = startBridgeDownloadJob(
      bridge,
      {
        url: "https://example.com/model.gguf",
        dest: "/models/model.gguf",
        sha256: null,
        jobId: JOB_ID,
      },
      { signal: caller.signal, timeoutMs: 60_000 },
    );
    caller.abort();
    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        !(error instanceof BridgeDownloadControlError)
        && error instanceof Error
        && (error.name === "AbortError" || /abort/i.test(error.message)),
    );
  });
});
