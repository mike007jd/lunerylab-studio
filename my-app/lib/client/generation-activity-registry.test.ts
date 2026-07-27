import { describe, expect, it } from "vitest";
import { GenerationActivityRegistry } from "@/components/studio/controllers/generation-activity-registry";

function activity(entryId: string, runId: string) {
  return {
    entryId,
    runId,
    mode: "image" as const,
    requestController: new AbortController(),
    pollController: new AbortController(),
  };
}

describe("generation activity registry", () => {
  it("keeps B active when concurrent A finishes first", () => {
    const registry = new GenerationActivityRegistry();
    expect(registry.begin(activity("A", "run-A"))).toBe(true);
    expect(registry.begin(activity("B", "run-B"))).toBe(true);

    expect(registry.finish("A", "run-A")).toBe(true);
    expect(registry.anyActive()).toBe(true);
    expect(registry.get("A")).toBeUndefined();
    expect(registry.get("B")?.runId).toBe("run-B");
  });

  it("ignores a stale completion after cancel and retry", () => {
    const registry = new GenerationActivityRegistry();
    registry.begin(activity("A", "run-1"));
    registry.startCancellation("A", "run-1", Promise.resolve());
    registry.finish("A", "run-1");
    registry.begin(activity("A", "run-2"));

    expect(registry.finish("A", "run-1")).toBe(false);
    expect(registry.get("A")?.runId).toBe("run-2");
    expect(registry.get("A")?.cancelRequested).toBe(false);
  });

  it("aborts both controllers and clears the registry on teardown", () => {
    const registry = new GenerationActivityRegistry();
    registry.begin(activity("A", "run-A"));
    registry.begin(activity("B", "run-B"));
    const controls = [...registry.getSnapshot().values()];

    registry.abortAll();

    expect(registry.anyActive()).toBe(false);
    for (const control of controls) {
      expect(control.requestController.signal.aborted).toBe(true);
      expect(control.pollController.signal.aborted).toBe(true);
    }
  });
});
