import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchDesktopStatus,
  fetchRuntimeProbe,
  invalidateDesktopStatusCache,
  subscribeDesktopStatusInvalidation,
} from "@/hooks/use-desktop-available";

afterEach(() => {
  invalidateDesktopStatusCache();
  vi.unstubAllGlobals();
});

function statusResponse(runtimeId: string): Response {
  return new Response(
    JSON.stringify({
      available: true,
      local_runtimes: [{ id: runtimeId, status: "ready" }],
      accel: null,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("desktop status invalidation", () => {
  it("notifies mounted status readers so invalidation forces a fresh status read", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(statusResponse("old-runtime"))
      .mockResolvedValueOnce(statusResponse("new-runtime"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDesktopStatus()).resolves.toMatchObject({
      localRuntimes: [{ id: "old-runtime" }],
    });

    const observed: string[] = [];
    const unsubscribe = subscribeDesktopStatusInvalidation(() => {
      void fetchDesktopStatus().then((status) => {
        observed.push(status.localRuntimes?.[0]?.id ?? "none");
      });
    });

    try {
      invalidateDesktopStatusCache();

      await vi.waitFor(() => {
        expect(observed).toEqual(["new-runtime"]);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });
});

describe("runtime probe", () => {
  it("does not call the probe API for embedded runtime endpoints", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRuntimeProbe("embedded")).resolves.toBeNull();
    await expect(fetchRuntimeProbe("embedded-sdcpp")).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts loopback runtime endpoints to the probe API", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ reachable: true, endpoint: "http://127.0.0.1:11434", models: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRuntimeProbe("http://127.0.0.1:11434")).resolves.toMatchObject({
      reachable: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/desktop-runtime/runtime-probe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ endpoint: "http://127.0.0.1:11434" }),
      }),
    );
  });
});
