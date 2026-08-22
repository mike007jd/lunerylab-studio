import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Route the DNS-pinned transport back through global fetch so per-test stubs
// drive it (mirrors local-image.test).
vi.mock("@/lib/server/byok-shared", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/server/byok-shared")>();
  return {
    ...actual,
    createPinnedProviderFetch:
      () =>
      (input: URL | RequestInfo, init?: RequestInit): Promise<Response> =>
        (globalThis.fetch as typeof fetch)(input, init),
  };
});

import {
  cancelComfyPrompt,
  pollComfyJobUntilTerminal,
} from "@/lib/server/comfy-agent/comfy-client";

const endpoint = { url: "http://127.0.0.1:8188/" } as never;

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("pollComfyJobUntilTerminal", () => {
  it("resolves completed once the history entry reports completion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ p1: { status: { completed: true } } })),
    );
    const status = await pollComfyJobUntilTerminal(endpoint, "p1", new AbortController().signal, {
      intervalMs: 1,
    });
    expect(status).toBe("completed");
  });

  it("resolves failed when the history entry reports an execution error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ p1: { status: { status_str: "error" } } })),
    );
    const status = await pollComfyJobUntilTerminal(endpoint, "p1", new AbortController().signal, {
      intervalMs: 1,
    });
    expect(status).toBe("failed");
  });

  it("throws an AbortError as soon as the signal is aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(
      pollComfyJobUntilTerminal(endpoint, "p1", controller.signal, { intervalMs: 1 }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives up with null after the timeout without a terminal verdict", async () => {
    // Job never appears in history — poll should time out and return null.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    const status = await pollComfyJobUntilTerminal(endpoint, "p1", new AbortController().signal, {
      intervalMs: 1,
      timeoutMs: 30,
    });
    expect(status).toBeNull();
  });
});

describe("cancelComfyPrompt", () => {
  it("deletes the queued prompt and interrupts execution", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await cancelComfyPrompt(endpoint, "p1");
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.endsWith("/queue"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/interrupt"))).toBe(true);
  });
});
