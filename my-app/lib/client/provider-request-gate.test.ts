import { describe, expect, it, vi } from "vitest";
import {
  createProviderRequestGate,
  runProviderSaveSingleFlight,
} from "@/components/settings/desktop-runtime/utils";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("provider request gate", () => {
  it("starts only one provider save while the first click is still pending", async () => {
    const lock = { current: false };
    const pending = deferred<string>();
    const save = vi.fn(() => pending.promise);

    const firstClick = runProviderSaveSingleFlight(lock, save);
    const secondClick = runProviderSaveSingleFlight(lock, save);

    await expect(secondClick).resolves.toEqual({ started: false });
    expect(save).toHaveBeenCalledOnce();

    pending.resolve("saved");
    await expect(firstClick).resolves.toEqual({ started: true, value: "saved" });

    await expect(runProviderSaveSingleFlight(lock, save)).resolves.toEqual({
      started: true,
      value: "saved",
    });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("ignores a deferred save completion after switching providers", async () => {
    const gate = createProviderRequestGate();
    let activeProvider = "openai";
    const request = gate.begin(activeProvider);
    const pending = deferred<string>();
    const applyFeedback = vi.fn();
    const completion = pending.promise.then((feedback) => {
      if (gate.isCurrent(request, activeProvider)) applyFeedback(feedback);
    });

    activeProvider = "anthropic";
    gate.invalidate();
    pending.resolve("saved");
    await completion;

    expect(applyFeedback).not.toHaveBeenCalled();
  });

  it("does not accept an old test completion after switching away and back", async () => {
    const gate = createProviderRequestGate();
    let activeProvider = "openai";
    const request = gate.begin(activeProvider);
    const pending = deferred<boolean>();
    const applyTestResult = vi.fn();
    const completion = pending.promise.then((ok) => {
      if (gate.isCurrent(request, activeProvider)) applyTestResult(ok);
    });

    activeProvider = "anthropic";
    gate.invalidate();
    activeProvider = "openai";
    gate.invalidate();
    pending.resolve(true);
    await completion;

    expect(applyTestResult).not.toHaveBeenCalled();
  });

  it("lets only the latest same-provider request apply its deferred completion", async () => {
    const gate = createProviderRequestGate();
    const activeProvider = "openai";
    const first = gate.begin(activeProvider);
    const firstPending = deferred<string>();
    const applied = vi.fn();
    const firstCompletion = firstPending.promise.then((value) => {
      if (gate.isCurrent(first, activeProvider)) applied(value);
    });

    const latest = gate.begin(activeProvider);
    const latestPending = deferred<string>();
    const latestCompletion = latestPending.promise.then((value) => {
      if (gate.isCurrent(latest, activeProvider)) applied(value);
    });

    latestPending.resolve("latest");
    firstPending.resolve("stale");
    await Promise.all([firstCompletion, latestCompletion]);

    expect(applied).toHaveBeenCalledOnce();
    expect(applied).toHaveBeenCalledWith("latest");
  });
});
