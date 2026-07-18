import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCanvasSessionRefreshSignature,
  createCanvasSessionRefreshController,
  probeCanvasSessionRefresh,
} from "@/components/canvas/use-canvas-session-refresh";
import type { CanvasSessionResponse } from "@/lib/client/canvas-sessions";

function sessionWithLocked(locked: boolean): CanvasSessionResponse["session"] {
  return {
    id: "session-1",
    updatedAt: "2026-06-17T00:00:00.000Z",
    layers: [
      {
        id: "layer-1",
        assetId: "asset-1",
        x: 10,
        y: 20,
        width: 300,
        height: 200,
        rotation: 0,
        zIndex: 1,
        hidden: false,
        locked,
      },
    ],
  };
}

describe("buildCanvasSessionRefreshSignature", () => {
  it("treats locked-only changes as render-relevant", () => {
    expect(buildCanvasSessionRefreshSignature(sessionWithLocked(false))).not.toBe(
      buildCanvasSessionRefreshSignature(sessionWithLocked(true)),
    );
  });
});

describe("probeCanvasSessionRefresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stops after the lightweight probe when the revision is unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ revision: "revision-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      probeCanvasSessionRefresh(
        "session-1",
        "revision-1",
        new AbortController().signal,
      ),
    ).resolves.toEqual({ revision: "revision-1" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/canvas/sessions/session-1/revision",
    );
  });

  it("loads the full session only after a changed revision", async () => {
    const session = sessionWithLocked(false);
    session.updatedAt = "parent-session-timestamp";
    const compositeRevision = "parent-session-timestamp|1|latest-layer-timestamp";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revision: compositeRevision }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      probeCanvasSessionRefresh(
        "session-1",
        "revision-1",
        new AbortController().signal,
      ),
    ).resolves.toEqual({ revision: compositeRevision, session });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/canvas/sessions/session-1");
  });

  it("reuses the composite revision so the next unchanged probe stays lightweight", async () => {
    const session = sessionWithLocked(false);
    const compositeRevision = "session-revision|1|layer-revision";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revision: compositeRevision }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revision: compositeRevision }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const changed = await probeCanvasSessionRefresh(
      "session-1",
      "older-revision",
      new AbortController().signal,
    );
    const unchanged = await probeCanvasSessionRefresh(
      "session-1",
      changed.revision,
      new AbortController().signal,
    );

    expect(unchanged).toEqual({ revision: compositeRevision });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("createCanvasSessionRefreshController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never overlaps probes and runs one queued refresh after the active probe", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: { revision: string }) => void;
    const first = new Promise<{ revision: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const probe = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ revision: "revision-2" });
    const controller = createCanvasSessionRefreshController({
      sessionId: "session-1",
      intervalMs: 3000,
      isVisible: () => true,
      onChanged: vi.fn(),
      probe,
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(3000);
    controller.requestRefresh();
    expect(probe).toHaveBeenCalledOnce();

    resolveFirst({ revision: "revision-1" });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    controller.stop();
  });

  it("aborts an active probe and leaves no scheduled work after stop", async () => {
    vi.useFakeTimers();
    let activeSignal: AbortSignal | undefined;
    const probe = vi.fn(
      (_sessionId: string, _revision: string | null, signal: AbortSignal) => {
        activeSignal = signal;
        return new Promise<{ revision: string }>(() => {});
      },
    );
    const controller = createCanvasSessionRefreshController({
      sessionId: "session-1",
      intervalMs: 3000,
      isVisible: () => true,
      onChanged: vi.fn(),
      probe,
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(3000);
    controller.stop();
    expect(activeSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(probe).toHaveBeenCalledOnce();
  });
});
