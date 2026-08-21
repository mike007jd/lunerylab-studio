import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANVAS_REPORT_TTL_MS,
  getComfyCanvasReport,
  isComfyRelayOrigin,
  resetComfyCanvasReportForTests,
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
  it("returns a freshly stored report", () => {
    storeComfyCanvasReport({ prompt: { "3": { class_type: "KSampler" } } });
    const report = getComfyCanvasReport();
    expect(report?.prompt).toEqual({ "3": { class_type: "KSampler" } });
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
