import { describe, expect, it, vi } from "vitest";
import {
  createKeyedSingleFlight,
  resolveImageGenerationOutcome,
} from "@/lib/client/generation-presentation";
import type { GenerationResponse } from "@/lib/types/api";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Studio generation safety", () => {
  it("runs at most one paid retry for the same history entry", async () => {
    const pending = deferred();
    const operation = vi.fn(async () => pending.promise);
    const singleFlight = createKeyedSingleFlight();

    const first = singleFlight.run("entry-1", operation);
    const duplicate = singleFlight.run("entry-1", operation);

    expect(operation).toHaveBeenCalledOnce();
    expect(await duplicate).toEqual({ started: false });

    pending.resolve();
    await expect(first).resolves.toEqual({ started: true, value: undefined });
  });

  it("treats an HTTP-success response with zero assets as a failed generation", () => {
    const response: GenerationResponse = {
      job: {
        id: "job-1",
        status: "SUCCEEDED",
        requestedCount: 1,
        successCount: 0,
        projectId: null,
      },
      assets: [],
      warnings: [],
    };

    expect(resolveImageGenerationOutcome(response, "No image was generated.")).toEqual({
      status: "failed",
      assets: [],
      warnings: [],
      succeededCount: 0,
      error: "No image was generated.",
    });
  });
});
