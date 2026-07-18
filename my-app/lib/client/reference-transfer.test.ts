import { describe, expect, it, vi } from "vitest";
import {
  fetchPendingReference,
  shouldClearPendingReference,
} from "@/lib/client/reference-transfer";

describe("Studio pending reference transfer", () => {
  it("retains the handoff after aborts and transient HTTP failures", async () => {
    const controller = new AbortController();
    controller.abort();

    const aborted = await fetchPendingReference(
      "asset-1",
      controller.signal,
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const unavailable = await fetchPendingReference(
      "asset-1",
      undefined,
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    expect(aborted.kind).toBe("transient-failure");
    expect(unavailable.kind).toBe("transient-failure");
    expect(shouldClearPendingReference(aborted)).toBe(false);
    expect(shouldClearPendingReference(unavailable)).toBe(false);
  });

  it("clears the handoff after success or permanent invalidity", async () => {
    const success = await fetchPendingReference(
      "asset-1",
      undefined,
      vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" },
      })),
    );
    const missing = await fetchPendingReference(
      "asset-missing",
      undefined,
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const invalidMedia = await fetchPendingReference(
      "asset-text",
      undefined,
      vi.fn(async () => new Response("not an image", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })),
    );

    expect(success.kind).toBe("success");
    expect(missing.kind).toBe("permanent-failure");
    expect(invalidMedia.kind).toBe("permanent-failure");
    expect(shouldClearPendingReference(success)).toBe(true);
    expect(shouldClearPendingReference(missing)).toBe(true);
    expect(shouldClearPendingReference(invalidMedia)).toBe(true);
  });
});
