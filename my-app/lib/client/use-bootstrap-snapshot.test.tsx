// @vitest-environment happy-dom

import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  snapshotsDiffer,
  useBootstrapSnapshot,
  type BootstrapSnapshot,
} from "@/lib/client/use-bootstrap-snapshot";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

function snapshot(label: string): BootstrapSnapshot {
  return {
    user: null,
    app: {
      defaultLocale: label,
      defaultTextModel: "",
      defaultImageModel: "",
      defaultVideoModel: "",
    },
    providers: { openai: { configured: true, source: "keychain" } },
    providerConnections: {
      openai: {
        endpoint: "https://api.openai.com/v1",
        models: { text: "gpt-5.4" },
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("bootstrap snapshot provider connections", () => {
  it("keeps an unchanged profile snapshot stable", () => {
    expect(snapshotsDiffer(snapshot("en"), snapshot("en"))).toBe(false);
  });

  it("invalidates consumers when a profile-owned model selection changes", () => {
    const previous = snapshot("en");
    const next = snapshot("en");
    next.providerConnections.openai = {
      ...next.providerConnections.openai!,
      models: { text: "gpt-5.5" },
      updatedAt: "2026-07-13T00:01:00.000Z",
    };
    expect(snapshotsDiffer(previous, next)).toBe(true);
  });

  it("invalidates consumers when a provider connection is removed", () => {
    const previous = snapshot("en");
    const next = snapshot("en");
    next.providerConnections = {};
    expect(snapshotsDiffer(previous, next)).toBe(true);
  });
});

describe("useBootstrapSnapshot initialData synchronization", () => {
  let root: Root;
  let container: HTMLDivElement;
  let observedLocale = "";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    observedLocale = "";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("syncs state and the comparison ref when initialData changes A → B, then keeps poll B", async () => {
    vi.useFakeTimers();
    const snapshotA = snapshot("A");
    const snapshotB = snapshot("B");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => snapshotB,
    });

    function Probe({ initialData }: { initialData: BootstrapSnapshot }) {
      const current = useBootstrapSnapshot({
        initialData,
        intervalMs: 1_000,
      });
      useEffect(() => {
        observedLocale = current?.app.defaultLocale ?? "";
      }, [current]);
      return null;
    }

    function Harness() {
      const [seed, setSeed] = useState(snapshotA);
      return (
        <>
          <button type="button" onClick={() => setSeed(snapshotB)}>
            to-b
          </button>
          <Probe initialData={seed} />
        </>
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });
    expect(observedLocale).toBe("A");
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      container.querySelector("button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(observedLocale).toBe("B");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observedLocale).toBe("B");
  });

  it("resumes polling after the page hides while a scheduled fetch is in flight", async () => {
    vi.useFakeTimers();
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const firstFetch = deferred<{
      ok: boolean;
      json: () => Promise<BootstrapSnapshot>;
    }>();
    fetchMock
      .mockReturnValueOnce(firstFetch.promise)
      .mockResolvedValue({
        ok: true,
        json: async () => snapshot("C"),
      });

    function Probe() {
      useBootstrapSnapshot({ initialData: snapshot("A"), intervalMs: 1_000 });
      return null;
    }

    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    // Visibility resume shares the in-flight request and owns exactly one
    // recurring timer. Advancing three intervals must add three requests, not
    // multiply timers after the original request settles.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      firstFetch.resolve({
        ok: true,
        json: async () => snapshot("B"),
      });
      await firstFetch.promise;
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
