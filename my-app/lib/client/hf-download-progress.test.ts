import { describe, expect, it } from "vitest";
import {
  measureDownloadSpeed,
  normalizeDownloadStatus,
  reduceBridgeDownloadSnapshot,
  resolveHfDownloadKit,
} from "./hf-download-progress";

describe("hf-download progress helpers", () => {
  it("normalizes unknown bridge statuses without throwing away progress data", () => {
    expect(normalizeDownloadStatus("downloading")).toBe("downloading");
    expect(normalizeDownloadStatus("bridge-added-a-status")).toBe("unknown");
  });

  it("resolves single-file model kits without forcing a companion file param", () => {
    const kit = resolveHfDownloadKit("qwen3.6-35b-a3b-ud-q4-k-m");

    expect(kit.multi).toBe(false);
    expect(kit.files).toHaveLength(1);
    expect(kit.files[0]?.name).toBe("Qwen3.6-35B-A3B-UD-Q4_K_M.gguf");
    expect(kit.total).toBeGreaterThan(0);
  });

  it("resolves companion model kits with the main file first", () => {
    const kit = resolveHfDownloadKit("flux2-dev-q4");

    expect(kit.multi).toBe(true);
    expect(kit.files.map((file) => file.name)).toEqual([
      "flux2-dev-Q4_K_M.gguf",
      "full_encoder_small_decoder.safetensors",
      "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
    ]);
    expect(kit.files.reduce((sum, file) => sum + file.size, 0)).toBe(kit.total);
  });

  it("keeps single-file progress indeterminate when the bridge has no total", () => {
    const kit = resolveHfDownloadKit("qwen3.6-35b-a3b-ud-q4-k-m");
    const reduced = reduceBridgeDownloadSnapshot({
      snapshot: { status: "downloading", received: 200, total: 0, error: null },
      previousSpeedSample: null,
      completedBytes: 0,
      fileIndex: 0,
      jobId: "job-1",
      kit,
      timestamp: 1_000,
    });

    expect(reduced.progress).toMatchObject({
      status: "downloading",
      percent: null,
      received: 200,
      total: 0,
      speedBps: 0,
      jobId: "job-1",
      fileIndex: 0,
      fileCount: 1,
    });
    expect(reduced.terminalStatus).toBeNull();
  });

  it("aggregates companion-kit progress against the whole kit total", () => {
    const kit = {
      multi: true,
      total: 1_000,
      files: [
        { name: "main", size: 700 },
        { name: "decoder", size: 300 },
      ],
    };
    const reduced = reduceBridgeDownloadSnapshot({
      snapshot: { status: "ready", received: 150, total: 300, error: null },
      previousSpeedSample: { received: 50, timestamp: 1_000 },
      completedBytes: 700,
      fileIndex: 1,
      jobId: "job-2",
      kit,
      timestamp: 3_000,
    });

    expect(reduced.progress).toMatchObject({
      status: "ready",
      percent: 85,
      received: 850,
      total: 1_000,
      speedBps: 50,
      fileIndex: 1,
      fileCount: 2,
    });
    expect(reduced.terminalStatus).toBe("ready");
  });

  it("clamps negative speed samples to zero", () => {
    expect(measureDownloadSpeed({ received: 200, timestamp: 1_000 }, 100, 2_000)).toMatchObject({
      speedBps: 0,
      speedSample: { received: 100, timestamp: 2_000 },
    });
  });
});
