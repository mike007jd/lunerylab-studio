interface LatestWriteQueueOptions<T> {
  write: (value: T, signal: AbortSignal) => Promise<void>;
  mergePending?: (older: T, newer: T) => T;
  maxRetries: number;
  retryDelayMs: (attempt: number) => number;
  /** Hard ceiling for one write attempt, including a stalled fetch. */
  writeTimeoutMs?: number;
  onStart?: () => void;
  onSettled?: (succeeded: boolean) => void;
  onLatestSaved?: (value: T) => void;
  onExhausted?: (error: unknown) => void;
}

export interface LatestWriteQueue<T> {
  enqueue: (value: T) => void;
  /** Resolve after pending writes and bounded retries settle. */
  flush: () => Promise<boolean>;
  /** Stop accepting edits, cancel retries, and detach UI callbacks after unmount. */
  close: () => void;
}

/**
 * Serializes writes while coalescing queued values to the newest one.
 * This prevents a slow older request from landing after a newer state and
 * gives the caller one explicit terminal-failure signal after bounded retry.
 */
export function createLatestWriteQueue<T>({
  write,
  mergePending,
  maxRetries,
  retryDelayMs,
  writeTimeoutMs = 10_000,
  onStart,
  onSettled,
  onLatestSaved,
  onExhausted,
}: LatestWriteQueueOptions<T>): LatestWriteQueue<T> {
  let pending: T | null = null;
  let active: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failedAttempts = 0;
  let pausedAfterFailure = false;
  let closed = false;
  let terminalFailure = false;
  let idleWaiters: Array<(succeeded: boolean) => void> = [];

  const resolveIdleWaiters = () => {
    if (active || retryTimer || (pending && !pausedAfterFailure)) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve(!terminalFailure);
  };

  const drain = () => {
    if (active || !pending || pausedAfterFailure) return;

    active = (async () => {
      while (pending) {
        const current: T = pending;
        pending = null;
        if (!closed) onStart?.();
        let succeeded = false;
        let shouldAttemptNewerAfterClose = false;
        const abortController = new AbortController();
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const timeout = new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            const error = new Error(`Canvas write timed out after ${writeTimeoutMs} ms`);
            error.name = "TimeoutError";
            abortController.abort(error);
            reject(error);
          }, writeTimeoutMs);
        });
        try {
          // Production writers must pass the signal to fetch. Promise.race is
          // retained as a final guard so flush waiters still resolve even if a
          // future writer accidentally ignores cancellation.
          await Promise.race([write(current, abortController.signal), timeout]);
          succeeded = true;
          failedAttempts = 0;
          terminalFailure = false;
          if (!pending && !closed) onLatestSaved?.(current);
        } catch (error) {
          const hasNewerPending = pending !== null;
          // Never restore an older value over a newer edit that arrived while
          // this request was in flight.
          pending = pending
            ? (mergePending?.(current, pending) ?? pending)
            : current;
          failedAttempts += 1;
          if (closed && hasNewerPending) {
            // The active request was already in flight when close began. It is
            // not the final write if a newer value was queued behind it, so
            // give the merged latest value exactly one delivery attempt.
            pausedAfterFailure = false;
            shouldAttemptNewerAfterClose = true;
          } else if (!closed && failedAttempts <= maxRetries) {
            retryTimer = setTimeout(() => {
              retryTimer = null;
              drain();
            }, retryDelayMs(failedAttempts));
          } else {
            pausedAfterFailure = true;
            terminalFailure = true;
            if (closed) pending = null;
            if (!closed) onExhausted?.(error);
          }
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
          if (!closed) onSettled?.(succeeded);
        }

        if (!succeeded && !shouldAttemptNewerAfterClose) break;
      }
    })().finally(() => {
      active = null;
      if (pending && !retryTimer && !pausedAfterFailure) drain();
      resolveIdleWaiters();
    });
  };

  return {
    enqueue(value) {
      if (closed) return;
      terminalFailure = false;
      pending = pending
        ? (mergePending?.(pending, value) ?? value)
        : value;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      drain();
    },
    flush() {
      // A deliberate flush is the recovery action after the automatic retry
      // budget is exhausted. Ordinary edits only replace the pending latest
      // value; they cannot silently create an unbounded retry loop.
      if (pausedAfterFailure && pending) {
        pausedAfterFailure = false;
        failedAttempts = 0;
        terminalFailure = false;
      }
      drain();
      if (!active && (!pending || pausedAfterFailure) && !retryTimer) {
        return Promise.resolve(!terminalFailure);
      }
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    close() {
      if (closed) return;
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      failedAttempts = maxRetries + 1;
      pausedAfterFailure = false;
      // If a write is active, its successful completion drains the one latest
      // coalesced value. If idle, start that final write now. No retry or UI
      // callback survives the owning component.
      drain();
      resolveIdleWaiters();
    },
  };
}
