import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToBridge: vi.fn(),
}));

vi.mock("@/lib/server/desktop-bridge", () => ({
  proxyToBridge: mocks.proxyToBridge,
}));

import { refreshComfyCanvasReport } from "@/lib/server/comfy-agent/graph-state";
import {
  resetComfyCanvasReportForTests,
  storeComfyCanvasReport,
} from "@/lib/server/comfy-canvas-report";

const bridge = { url: "http://127.0.0.1:1", token: "t" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  resetComfyCanvasReportForTests();
  mocks.proxyToBridge.mockResolvedValue({ ok: true });
});

afterEach(() => {
  resetComfyCanvasReportForTests();
});

describe("refreshComfyCanvasReport connection scoping", () => {
  it("returns a cached report that belongs to the requested connection", async () => {
    storeComfyCanvasReport({
      prompt: { "3": { class_type: "KSampler" } },
      connectionEndpoint: "http://192.168.1.10:8188",
    });

    const report = await refreshComfyCanvasReport(bridge, "http://192.168.1.10:8188", 200);

    expect(report?.prompt).toEqual({ "3": { class_type: "KSampler" } });
  });

  it("never substitutes another connection's graph", async () => {
    storeComfyCanvasReport({
      prompt: { "9": { class_type: "OtherServerNode" } },
      connectionEndpoint: "http://192.168.1.99:8188",
    });

    const report = await refreshComfyCanvasReport(bridge, "http://192.168.1.10:8188", 200);

    expect(report).toBeNull();
  });

  it("returns null when the bridge cannot reach the canvas window", async () => {
    mocks.proxyToBridge.mockResolvedValue({ ok: false });
    const report = await refreshComfyCanvasReport(bridge, "http://192.168.1.10:8188", 200);
    expect(report).toBeNull();
  });
});
