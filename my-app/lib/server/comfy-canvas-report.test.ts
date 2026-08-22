import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANVAS_REPORT_TTL_MS,
  getComfyCanvasReport,
  isComfyRelayOrigin,
  isComfyReportOrigin,
  resetComfyCanvasReportForTests,
  setCurrentCanvasEndpoint,
  storeComfyCanvasReport,
} from "@/lib/server/comfy-canvas-report";

beforeEach(() => {
  resetComfyCanvasReportForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetComfyCanvasReportForTests();
});

describe("comfy canvas report cache", () => {
  it("returns a freshly stored report with its connection stamp", () => {
    storeComfyCanvasReport({
      prompt: { "3": { class_type: "KSampler" } },
      connectionEndpoint: "http://192.168.1.10:8188",
    });
    const report = getComfyCanvasReport();
    expect(report?.prompt).toEqual({ "3": { class_type: "KSampler" } });
    expect(report?.connectionEndpoint).toBe("http://192.168.1.10:8188");
    expect(typeof report?.receivedAt).toBe("string");
  });

  it("treats a report older than the TTL as absent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00.000Z"));
    storeComfyCanvasReport({ prompt: { "1": { class_type: "Node" } } });
    expect(getComfyCanvasReport()).not.toBeNull();

    vi.setSystemTime(new Date(Date.now() + CANVAS_REPORT_TTL_MS + 1_000));
    expect(getComfyCanvasReport()).toBeNull();
  });

  it("reset clears the cached report", () => {
    storeComfyCanvasReport({ prompt: { "1": {} } });
    resetComfyCanvasReportForTests();
    expect(getComfyCanvasReport()).toBeNull();
  });
});

describe("isComfyRelayOrigin", () => {
  it("accepts loopback relay origins on the reserved port range", () => {
    expect(isComfyRelayOrigin("http://127.0.0.1:8189")).toBe(true);
    expect(isComfyRelayOrigin("http://127.0.0.1:8199")).toBe(true);
  });

  it("rejects ports outside the range, non-loopback hosts, and https", () => {
    expect(isComfyRelayOrigin("http://127.0.0.1:8188")).toBe(false);
    expect(isComfyRelayOrigin("http://127.0.0.1:8200")).toBe(false);
    expect(isComfyRelayOrigin("http://192.168.1.10:8189")).toBe(false);
    expect(isComfyRelayOrigin("https://127.0.0.1:8189")).toBe(false);
    expect(isComfyRelayOrigin("not a url")).toBe(false);
    expect(isComfyRelayOrigin(null)).toBe(false);
  });
});

describe("isComfyReportOrigin", () => {
  it("accepts the relay origin regardless of the current canvas endpoint", () => {
    expect(isComfyReportOrigin("http://127.0.0.1:8189")).toBe(true);
  });

  it("accepts the exact https origin the canvas is currently attached to", () => {
    setCurrentCanvasEndpoint("https://comfy.example.com:8443/api");
    expect(isComfyReportOrigin("https://comfy.example.com:8443")).toBe(true);
    // A different https origin, or the same host over http, is still rejected.
    expect(isComfyReportOrigin("https://evil.example.com")).toBe(false);
    expect(isComfyReportOrigin("http://comfy.example.com:8443")).toBe(false);
  });

  it("does not authorize any https origin when the canvas is on a plain-http server", () => {
    setCurrentCanvasEndpoint("http://192.168.1.10:8188");
    expect(isComfyReportOrigin("https://192.168.1.10:8188")).toBe(false);
  });

  it("rejects everything when no canvas endpoint is bound", () => {
    setCurrentCanvasEndpoint(null);
    expect(isComfyReportOrigin("https://comfy.example.com")).toBe(false);
  });
});
