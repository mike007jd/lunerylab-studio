import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshComfyCanvasReport: vi.fn(),
  loadWorkflowOnCanvas: vi.fn(),
  applyWidgetEditsOnCanvas: vi.fn(),
  queueComfyPrompt: vi.fn(),
  cancelComfyPrompt: vi.fn(),
  trackComfyAgentJob: vi.fn(),
  recordComfyJobStarted: vi.fn(),
  recordComfyJobFinished: vi.fn(),
}));

vi.mock("@/lib/server/comfy-agent/graph-state", () => ({
  refreshComfyCanvasReport: mocks.refreshComfyCanvasReport,
}));

vi.mock("@/lib/server/comfy-agent/canvas-bridge", () => ({
  loadWorkflowOnCanvas: mocks.loadWorkflowOnCanvas,
  applyWidgetEditsOnCanvas: mocks.applyWidgetEditsOnCanvas,
}));

vi.mock("@/lib/server/comfy-agent/comfy-client", () => ({
  queueComfyPrompt: mocks.queueComfyPrompt,
  cancelComfyPrompt: mocks.cancelComfyPrompt,
}));

vi.mock("@/lib/server/comfy-agent/job-monitor", () => ({
  trackComfyAgentJob: mocks.trackComfyAgentJob,
}));

vi.mock("@/lib/server/comfy-activity", () => ({
  recordComfyJobStarted: mocks.recordComfyJobStarted,
  recordComfyJobFinished: mocks.recordComfyJobFinished,
}));

import {
  buildComfyAgentToolset,
  type ComfyAgentToolContext,
} from "@/lib/server/comfy-agent/tools";

// AI SDK types the tool's inputSchema/execute as opaque wrappers; at runtime
// they are the zod schema and the raw executor, so cast through `unknown`.
type Parseable = { safeParse: (value: unknown) => { success: boolean } };
type Executor = (input: unknown, options: unknown) => Promise<Record<string, unknown>>;

function toolContext(overrides: Partial<ComfyAgentToolContext> = {}): ComfyAgentToolContext {
  return {
    bridge: { url: "http://127.0.0.1:1", token: "t" } as never,
    endpoint: { url: "http://127.0.0.1:8188/" } as never,
    activeEndpointRaw: "http://127.0.0.1:8188",
    abortSignal: new AbortController().signal,
    recordStep: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadWorkflowOnCanvas.mockResolvedValue(undefined);
  mocks.applyWidgetEditsOnCanvas.mockResolvedValue(undefined);
  mocks.queueComfyPrompt.mockResolvedValue("prompt-1");
  mocks.cancelComfyPrompt.mockResolvedValue(undefined);
});

describe("edit_graph input schema", () => {
  it("rejects an unknown operation", () => {
    const { edit_graph } = buildComfyAgentToolset(toolContext());
    const result = (edit_graph.inputSchema as unknown as Parseable).safeParse({
      operations: [{ op: "delete_everything", nodeId: "3" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects add_node without a class_type", () => {
    const { edit_graph } = buildComfyAgentToolset(toolContext());
    const result = (edit_graph.inputSchema as unknown as Parseable).safeParse({
      operations: [{ op: "add_node", nodeId: "99" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a set_input link value and add_node", () => {
    const { edit_graph } = buildComfyAgentToolset(toolContext());
    const result = (edit_graph.inputSchema as unknown as Parseable).safeParse({
      operations: [
        { op: "set_input", nodeId: "3", name: "model", value: ["4", 0] },
        { op: "add_node", nodeId: "10", classType: "VAEDecode", inputs: { samples: ["3", 0] } },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("edit_graph merge", () => {
  function fullGraph() {
    return {
      "3": { class_type: "KSampler", inputs: { seed: 1, cfg: 8, model: ["4", 0] } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: "a".repeat(400) } },
      "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } },
    };
  }

  it("applies patches onto the lossless graph and preserves untouched nodes verbatim", async () => {
    mocks.refreshComfyCanvasReport.mockResolvedValue({
      prompt: fullGraph(),
      receivedAt: new Date().toISOString(),
    });
    const { edit_graph } = buildComfyAgentToolset(toolContext());
    const result = await (edit_graph.execute as unknown as Executor)(
      {
        operations: [
          { op: "set_input", nodeId: "6", name: "text", value: "a snowy mountain at dawn" },
          { op: "remove_node", nodeId: "9" },
        ],
      },
      {},
    );

    expect(result.ok).toBe(true);
    expect(mocks.loadWorkflowOnCanvas).toHaveBeenCalledTimes(1);
    const merged = mocks.loadWorkflowOnCanvas.mock.calls[0]![1] as Record<
      string,
      { class_type?: string; inputs?: Record<string, unknown> }
    >;
    // Untouched node preserved verbatim (long input not truncated).
    expect(merged["3"]).toEqual(fullGraph()["3"]);
    // Edited input applied.
    expect(merged["6"]!.inputs!.text).toBe("a snowy mountain at dawn");
    // Removed node gone.
    expect(merged["9"]).toBeUndefined();
  });

  it("fails without loading when an operation targets a missing node", async () => {
    mocks.refreshComfyCanvasReport.mockResolvedValue({
      prompt: fullGraph(),
      receivedAt: new Date().toISOString(),
    });
    const { edit_graph } = buildComfyAgentToolset(toolContext());
    const result = await (edit_graph.execute as unknown as Executor)(
      { operations: [{ op: "set_input", nodeId: "404", name: "x", value: 1 }] },
      {},
    );
    expect(result.ok).toBe(false);
    expect(mocks.loadWorkflowOnCanvas).not.toHaveBeenCalled();
  });

  it("reports canvas-not-open when no report is available", async () => {
    mocks.refreshComfyCanvasReport.mockResolvedValue(null);
    const { edit_graph } = buildComfyAgentToolset(toolContext());
    const result = await (edit_graph.execute as unknown as Executor)(
      { operations: [{ op: "remove_node", nodeId: "9" }] },
      {},
    );
    expect(result.ok).toBe(false);
    expect(mocks.loadWorkflowOnCanvas).not.toHaveBeenCalled();
  });

  it("applies pure literal widget edits in place to preserve layout", async () => {
    mocks.refreshComfyCanvasReport.mockResolvedValue({
      prompt: fullGraph(),
      receivedAt: new Date().toISOString(),
    });
    const { edit_graph } = buildComfyAgentToolset(toolContext());
    const result = await (edit_graph.execute as unknown as Executor)(
      {
        operations: [
          { op: "set_input", nodeId: "3", name: "cfg", value: 6 },
          { op: "set_input", nodeId: "6", name: "text", value: "a snowy peak" },
        ],
      },
      {},
    );

    expect(result.ok).toBe(true);
    // Layout-preserving live path, never a whole-graph reload.
    expect(mocks.applyWidgetEditsOnCanvas).toHaveBeenCalledTimes(1);
    expect(mocks.loadWorkflowOnCanvas).not.toHaveBeenCalled();
    const edits = mocks.applyWidgetEditsOnCanvas.mock.calls[0]![1];
    expect(edits).toEqual([
      { nodeId: "3", name: "cfg", value: 6 },
      { nodeId: "6", name: "text", value: "a snowy peak" },
    ]);
  });

  it("routes a set_input link rewrite through the reload path, not the widget path", async () => {
    mocks.refreshComfyCanvasReport.mockResolvedValue({
      prompt: fullGraph(),
      receivedAt: new Date().toISOString(),
    });
    const { edit_graph } = buildComfyAgentToolset(toolContext());
    const result = await (edit_graph.execute as unknown as Executor)(
      { operations: [{ op: "set_input", nodeId: "3", name: "model", value: ["4", 0] }] },
      {},
    );

    expect(result.ok).toBe(true);
    expect(mocks.loadWorkflowOnCanvas).toHaveBeenCalledTimes(1);
    expect(mocks.applyWidgetEditsOnCanvas).not.toHaveBeenCalled();
  });
});

describe("observe_graph", () => {
  it("bounds the node list and truncates long input strings", async () => {
    const prompt: Record<string, unknown> = {};
    for (let i = 0; i < 70; i += 1) {
      prompt[String(i)] = { class_type: "Node", inputs: { text: "x".repeat(500) } };
    }
    mocks.refreshComfyCanvasReport.mockResolvedValue({
      prompt,
      receivedAt: new Date().toISOString(),
    });

    const { observe_graph } = buildComfyAgentToolset(toolContext());
    const result = (await (observe_graph.execute as unknown as Executor)({}, {})) as {
      ok: boolean;
      nodeCount: number;
      truncated: boolean;
      nodes: Array<{ inputs: Record<string, string> }>;
    };

    expect(result.ok).toBe(true);
    expect(result.nodeCount).toBe(70);
    expect(result.truncated).toBe(true);
    expect(result.nodes).toHaveLength(60);
    const text = result.nodes[0]!.inputs.text!;
    expect(text.length).toBeLessThanOrEqual(201);
    expect(text.endsWith("…")).toBe(true);
  });

  it("reports canvas-not-open when no report lands", async () => {
    mocks.refreshComfyCanvasReport.mockResolvedValue(null);
    const { observe_graph } = buildComfyAgentToolset(toolContext());
    const result = (await (observe_graph.execute as unknown as Executor)({}, {})) as {
      ok: boolean;
    };
    expect(result.ok).toBe(false);
  });
});

describe("queue_prompt lifecycle", () => {
  function report() {
    return {
      prompt: { "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } } },
      receivedAt: new Date().toISOString(),
    };
  }

  it("queues, records started, and hands off to the terminal-state watcher", async () => {
    mocks.refreshComfyCanvasReport.mockResolvedValue(report());
    const { queue_prompt } = buildComfyAgentToolset(toolContext());
    const result = await (queue_prompt.execute as unknown as Executor)({}, {});

    expect(result).toEqual({ ok: true, promptId: "prompt-1" });
    expect(mocks.recordComfyJobStarted).toHaveBeenCalledTimes(1);
    expect(mocks.trackComfyAgentJob).toHaveBeenCalledTimes(1);
    expect(mocks.cancelComfyPrompt).not.toHaveBeenCalled();
  });

  it("cancels the job on the server when the run was already stopped", async () => {
    mocks.refreshComfyCanvasReport.mockResolvedValue(report());
    const controller = new AbortController();
    controller.abort();
    const { queue_prompt } = buildComfyAgentToolset(
      toolContext({ abortSignal: controller.signal }),
    );
    const result = await (queue_prompt.execute as unknown as Executor)({}, {});

    expect(result.ok).toBe(false);
    expect(mocks.cancelComfyPrompt).toHaveBeenCalledWith(
      expect.anything(),
      "prompt-1",
    );
    expect(mocks.recordComfyJobFinished).toHaveBeenCalledWith(
      "http://127.0.0.1:8188",
      "prompt-1",
      "cancelled",
    );
    // A stopped run must not leave a live watcher polling a cancelled job.
    expect(mocks.trackComfyAgentJob).not.toHaveBeenCalled();
  });
});

describe("toolset surface", () => {
  it("does not expose server-mutating Manager tools", () => {
    const toolset = buildComfyAgentToolset(toolContext());
    expect(Object.keys(toolset).sort()).toEqual(
      ["edit_graph", "get_server_stats", "list_model_files", "observe_graph", "queue_prompt"].sort(),
    );
    expect("install_custom_node" in toolset).toBe(false);
    expect("reboot_server" in toolset).toBe(false);
  });
});
