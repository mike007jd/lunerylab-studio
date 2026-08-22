import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pollComfyJobUntilTerminal: vi.fn(),
  cancelComfyPrompt: vi.fn(),
  recordComfyJobFinished: vi.fn(),
}));

vi.mock("@/lib/server/comfy-agent/comfy-client", () => ({
  pollComfyJobUntilTerminal: mocks.pollComfyJobUntilTerminal,
  cancelComfyPrompt: mocks.cancelComfyPrompt,
}));

vi.mock("@/lib/server/comfy-activity", () => ({
  recordComfyJobFinished: mocks.recordComfyJobFinished,
}));

import { trackComfyAgentJob } from "@/lib/server/comfy-agent/job-monitor";

const endpoint = { url: "http://127.0.0.1:8188/" } as never;
const raw = "http://127.0.0.1:8188";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancelComfyPrompt.mockResolvedValue(undefined);
});

describe("trackComfyAgentJob", () => {
  it("records the terminal status the poll observed", async () => {
    mocks.pollComfyJobUntilTerminal.mockResolvedValue("completed");
    await trackComfyAgentJob(endpoint, raw, "p1", new AbortController().signal);
    expect(mocks.recordComfyJobFinished).toHaveBeenCalledWith(raw, "p1", "completed");
    expect(mocks.cancelComfyPrompt).not.toHaveBeenCalled();
  });

  it("leaves the feed untouched when the watcher times out without a verdict", async () => {
    mocks.pollComfyJobUntilTerminal.mockResolvedValue(null);
    await trackComfyAgentJob(endpoint, raw, "p1", new AbortController().signal);
    expect(mocks.recordComfyJobFinished).not.toHaveBeenCalled();
  });

  it("cancels the server job and records cancelled on abort", async () => {
    mocks.pollComfyJobUntilTerminal.mockRejectedValue(
      new DOMException("Aborted", "AbortError"),
    );
    await trackComfyAgentJob(endpoint, raw, "p1", new AbortController().signal);
    expect(mocks.cancelComfyPrompt).toHaveBeenCalledWith(endpoint, "p1");
    expect(mocks.recordComfyJobFinished).toHaveBeenCalledWith(raw, "p1", "cancelled");
  });

  it("records failed on a non-abort error", async () => {
    mocks.pollComfyJobUntilTerminal.mockRejectedValue(new Error("network"));
    await trackComfyAgentJob(endpoint, raw, "p1", new AbortController().signal);
    expect(mocks.cancelComfyPrompt).not.toHaveBeenCalled();
    expect(mocks.recordComfyJobFinished).toHaveBeenCalledWith(raw, "p1", "failed");
  });
});
