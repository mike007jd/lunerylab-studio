import { createElement, isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import CanvasLayout from "@/app/canvas/layout";
import { CreativeCapabilityReadinessProvider } from "@/hooks/use-creative-capability-readiness";
import { BootstrapSnapshotProvider } from "@/lib/client/bootstrap-snapshot-provider";

describe("CanvasLayout", () => {
  it("mounts the capability providers required by the canvas workspace", async () => {
    const child = createElement("div", null, "canvas");
    const bootstrapBoundary = (await CanvasLayout({ children: child })) as ReactElement<{
      children: ReactElement<{ children: ReactElement }>;
    }>;

    expect(isValidElement(bootstrapBoundary)).toBe(true);
    expect(bootstrapBoundary.type).toBe(BootstrapSnapshotProvider);

    const readinessBoundary = bootstrapBoundary.props.children;
    expect(isValidElement(readinessBoundary)).toBe(true);
    expect(readinessBoundary.type).toBe(CreativeCapabilityReadinessProvider);
    expect(readinessBoundary.props.children).toBe(child);
  });
});
