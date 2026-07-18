import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "./fetch-json";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJson", () => {
  it("uses route error messages from error payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Model file is missing." }), {
          status: 404,
          statusText: "Not Found",
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(fetchJson("/api/example")).rejects.toMatchObject({
      message: "Model file is missing. (404 Not Found)",
      status: 404,
    });
  });

  it("keeps message payloads working", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: "Prompt is required." }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(fetchJson("/api/example")).rejects.toMatchObject({
      message: "Prompt is required. (400 Bad Request)",
      status: 400,
    });
  });
});
