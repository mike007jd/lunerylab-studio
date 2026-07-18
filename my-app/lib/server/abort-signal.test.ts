import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withTimeoutSignal } from "@/lib/server/byok-shared";

describe("withTimeoutSignal (#12)", () => {
  it("aborts the merged signal when the caller (user Stop) aborts", () => {
    const controller = new AbortController();
    const merged = withTimeoutSignal(controller.signal, 60_000);

    expect(merged.aborted).toBe(false);
    controller.abort(new Error("user stop"));
    // The provider request's signal now reflects the user's stop immediately,
    // instead of waiting for the internal timeout.
    expect(merged.aborted).toBe(true);
  });

  it("returns a timeout-only signal when there is no caller signal", () => {
    const merged = withTimeoutSignal(undefined, 60_000);
    expect(merged).toBeInstanceOf(AbortSignal);
    expect(merged.aborted).toBe(false);
  });
});
