import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshComfyCanvasReport: vi.fn(),
  loadWorkflowOnCanvas: vi.fn(),
  transport: vi.fn(),
}));

vi.mock("@/lib/server/comfy-agent/graph-state", () => ({
  refreshComfyCanvasReport: mocks.refreshComfyCanvasReport,
}));

vi.mock("@/lib/server/comfy-agent/canvas-bridge", () => ({
  loadWorkflowOnCanvas: mocks.loadWorkflowOnCanvas,
}));

// Keep every real byok-shared export except the pinned transport, which is
// swapped for a stub so Manager probes never touch the network.
vi.mock("@/lib/server/byok-shared", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/server/byok-shared")>();
  return { ...actual, createPinnedProviderFetch: () => mocks.transport };
});

import {
  buildComfyAgentToolset,
  type ComfyAgentToolContext,
} from "@/lib/server/comfy-agent/tools";
import { listManagerCustomNodes } from "@/lib/server/comfy-agent/comfy-client";

// AI SDK types the tool's inputSchema/execute as opaque wrappers; at runtime
// they are the zod schema and the raw executor, so cast through `unknown`.
type Parseable = { safeParse: (value: unknown) => { success: boolean } };
type Executor = (input: unknown, options: unknown) => Promise<Record<string, unknown>>;

function toolContext(): ComfyAgentToolContext {
  return {
    bridge: { url: "http://127.0.0.1:1", token: "t" } as never,
    endpoint: { url: "http://127.0.0.1:8188/" } as never,
    activeEndpointRaw: "http://127.0.0.1:8188",
    abortSignal: new AbortController().signal,
    recordStep: () => {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("edit_graph input schema", () => {
  it("rejects a node missing class_type", () => {
    const { edit_graph } = buildComfyAgentToolset(toolContext());
    const result = (edit_graph.inputSchema as unknown as Parseable).safeParse({ workflow: { "3": { inputs: {} } } });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object node entry", () => {
    const { edit_graph } = buildComfyAgentToolset(toolContext());
    const result = (edit_graph.inputSchema as unknown as Parseable).safeParse({ workflow: { "3": "nope" } });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed API-format workflow", () => {
    const { edit_graph } = buildComfyAgentToolset(toolContext());
    const result = (edit_graph.inputSchema as unknown as Parseable).safeParse({
      workflow: {
        "3": { class_type: "KSampler", inputs: { seed: 1, model: ["4", 0] } },
        "4": { class_type: "CheckpointLoaderSimple", inputs: {} },
      },
    });
    expect(result.success).toBe(true);
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

describe("Manager probe", () => {
  it("reports available:false when both installed-node endpoints 404", async () => {
    mocks.transport.mockResolvedValue(new Response(null, { status: 404 }));
    const result = await listManagerCustomNodes({ url: "http://127.0.0.1:8188/" } as never);
    expect(result.available).toBe(false);
    expect(result.nodes).toEqual([]);
    expect(mocks.transport).toHaveBeenCalledTimes(2);
  });
});
