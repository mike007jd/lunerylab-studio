// Toolset for the ComfyUI workspace agent.
//
// Every tool talks to exactly two surfaces: the attached (validated) ComfyUI
// server through the DNS-pinned transport, and the native canvas window via
// the desktop bridge. Tools return structured {ok, ...} results so the model
// can react to failures instead of crashing the run.

import "server-only";
import { tool } from "ai";
import { z } from "zod";
import type { DesktopBridge } from "@/lib/server/desktop-bridge";
import {
  COMFY_MODEL_FOLDERS,
  fetchComfyModelFolder,
  fetchComfySystemStats,
  type ValidatedComfyEndpoint,
} from "@/lib/server/comfy-endpoint";
import { recordComfyJobFinished, recordComfyJobStarted } from "@/lib/server/comfy-activity";
import { refreshComfyCanvasReport } from "@/lib/server/comfy-agent/graph-state";
import {
  applyWidgetEditsOnCanvas,
  loadWorkflowOnCanvas,
} from "@/lib/server/comfy-agent/canvas-bridge";
import { cancelComfyPrompt, queueComfyPrompt } from "@/lib/server/comfy-agent/comfy-client";
import { trackComfyAgentJob } from "@/lib/server/comfy-agent/job-monitor";

export interface ComfyAgentToolContext {
  bridge: DesktopBridge;
  endpoint: ValidatedComfyEndpoint;
  /** The connection's saved endpoint string (activity-feed matching key). */
  activeEndpointRaw: string;
  abortSignal: AbortSignal;
  recordStep: (summary: string, toolName: string) => void;
}

const MAX_OBSERVE_NODES = 60;
const MAX_INPUT_TEXT = 200;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function summarizeInputs(inputs: unknown): Record<string, string> {
  const summary: Record<string, string> = {};
  if (!inputs || typeof inputs !== "object") return summary;
  for (const [key, value] of Object.entries(inputs as Record<string, unknown>)) {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") {
      summary[key] = `<link ${value[0]}:${String(value[1])}>`;
    } else if (typeof value === "string") {
      summary[key] = truncate(value, MAX_INPUT_TEXT);
    } else if (value === null || typeof value === "number" || typeof value === "boolean") {
      summary[key] = String(value);
    } else {
      summary[key] = truncate(JSON.stringify(value), 80);
    }
  }
  return summary;
}

/** First plausible prompt text in the graph, for the activity feed display. */
function extractPromptText(workflow: Record<string, unknown>): string {
  for (const node of Object.values(workflow)) {
    const inputs =
      node && typeof node === "object"
        ? ((node as Record<string, unknown>).inputs as Record<string, unknown> | undefined)
        : undefined;
    if (!inputs) continue;
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value === "string" && /^(text|prompt|positive|negative)/i.test(key)) {
        return truncate(value.replace(/\s+/g, " ").trim(), 120);
      }
    }
  }
  return "";
}

// A ComfyUI API-format node. inputs values are literals or a link
// [sourceNodeId, outputIndex].
interface ComfyNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
  [key: string]: unknown;
}

// An input value the model may set: a literal or a link to another node's
// output. Kept permissive so any valid ComfyUI value round-trips.
const linkValue = z.tuple([z.string().min(1), z.number()]);
const inputValue = z.union([z.string(), z.number(), z.boolean(), linkValue]);

// Targeted edit operations. The model never sends a full workflow — it can only
// describe changes, which are merged server-side onto the lossless live graph
// so every untouched node and parameter is preserved verbatim.
const editOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_input"),
    nodeId: z.string().min(1),
    name: z.string().min(1),
    value: inputValue,
  }),
  z.object({
    op: z.literal("set_class_type"),
    nodeId: z.string().min(1),
    classType: z.string().min(1),
  }),
  z.object({
    op: z.literal("add_node"),
    nodeId: z.string().min(1),
    classType: z.string().min(1),
    inputs: z.record(z.string(), inputValue).optional(),
  }),
  z.object({ op: z.literal("remove_node"), nodeId: z.string().min(1) }),
]);

type EditOperation = z.infer<typeof editOperationSchema>;

/**
 * Apply targeted edit operations to a full API-format graph in place. Throws a
 * model-facing message when an operation references a node that does not exist
 * (or re-adds one that does), so a stale observation cannot silently corrupt or
 * delete the graph.
 */
function applyGraphOperations(
  graph: Record<string, ComfyNode>,
  operations: EditOperation[],
): void {
  for (const op of operations) {
    if (op.op === "add_node") {
      if (graph[op.nodeId]) {
        throw new Error(
          `Node "${op.nodeId}" already exists — edit it with set_input/set_class_type instead of add_node.`,
        );
      }
      graph[op.nodeId] = { class_type: op.classType, inputs: op.inputs ?? {} };
      continue;
    }
    const node = graph[op.nodeId];
    if (!node) {
      throw new Error(
        `Node "${op.nodeId}" is not in the graph — call observe_graph again for current node ids.`,
      );
    }
    if (op.op === "remove_node") {
      delete graph[op.nodeId];
    } else if (op.op === "set_class_type") {
      node.class_type = op.classType;
    } else {
      if (!node.inputs || typeof node.inputs !== "object") node.inputs = {};
      (node.inputs as Record<string, unknown>)[op.name] = op.value;
    }
  }
}

// A single literal widget-value edit applied directly on the live frontend node.
interface WidgetEdit {
  nodeId: string;
  name: string;
  value: string | number | boolean;
}

/**
 * When every operation is a `set_input` carrying a literal value (not a link
 * `[nodeId, slot]`), return them as widget edits so edit_graph can mutate the
 * live graph in place and preserve layout. Any structural op (add/remove/retype)
 * or a link rewrite returns null, routing the batch through the reload path.
 */
function collectWidgetEdits(operations: EditOperation[]): WidgetEdit[] | null {
  const edits: WidgetEdit[] = [];
  for (const op of operations) {
    if (op.op !== "set_input" || Array.isArray(op.value)) return null;
    edits.push({ nodeId: op.nodeId, name: op.name, value: op.value });
  }
  return edits;
}

export function buildComfyAgentToolset(ctx: ComfyAgentToolContext) {
  return {
    observe_graph: tool({
      description:
        "Read the user's current ComfyUI graph from the canvas window. Call this before any edit and whenever you need current state.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        ctx.recordStep("Reading the live graph", "observe_graph");
        const report = await refreshComfyCanvasReport(ctx.bridge, ctx.activeEndpointRaw);
        if (!report) {
          return {
            ok: false,
            error:
              "The canvas window is not open or did not report its graph. Ask the user to click 'Open canvas'.",
          };
        }
        const entries = Object.entries(report.prompt);
        const nodes = entries.slice(0, MAX_OBSERVE_NODES).map(([id, node]) => {
          const inputs =
            node && typeof node === "object"
              ? (node as Record<string, unknown>).inputs
              : undefined;
          return { id, class_type: (node as Record<string, unknown>).class_type, inputs: summarizeInputs(inputs) };
        });
        ctx.recordStep(`Observed ${entries.length} nodes`, "observe_graph");
        return {
          ok: true,
          nodeCount: entries.length,
          truncated: entries.length > MAX_OBSERVE_NODES,
          nodes,
        };
      },
    }),

    edit_graph: tool({
      description:
        "Edit the canvas graph with targeted operations (set_input, set_class_type, add_node, remove_node). Never send a whole workflow — describe only what changes; every other node and parameter is preserved exactly. Call observe_graph first for current node ids and class_types.",
      inputSchema: z.object({
        operations: z.array(editOperationSchema).min(1).max(50),
      }),
      execute: async ({ operations }) => {
        ctx.recordStep("Reading the live graph to edit", "edit_graph");
        // Merge onto the lossless full graph, not the truncated observation, so
        // untouched nodes and long inputs survive verbatim.
        const report = await refreshComfyCanvasReport(ctx.bridge, ctx.activeEndpointRaw);
        if (!report) {
          return {
            ok: false,
            error:
              "The canvas window is not open or did not report its graph. Ask the user to click 'Open canvas'.",
          };
        }
        // Validate against the lossless live graph regardless of the apply path,
        // so a stale node id gives the model a precise error instead of a canvas
        // failure.
        const graph = structuredClone(report.prompt) as Record<string, ComfyNode>;
        try {
          applyGraphOperations(graph, operations);
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "The edit could not be applied.",
          };
        }
        // Pure widget-value edits are applied in place on the live frontend
        // graph so node positions, groups, and every untouched widget survive.
        // Structural edits (add/remove/rewire/retype) reload the merged
        // API-format graph — that re-lays-out, but a structural change already
        // implies a layout change.
        const widgetEdits = collectWidgetEdits(operations);
        try {
          if (widgetEdits) {
            await applyWidgetEditsOnCanvas(ctx.bridge, widgetEdits);
          } else {
            await loadWorkflowOnCanvas(ctx.bridge, graph);
          }
        } catch (error) {
          return {
            ok: false,
            error:
              error instanceof Error ? error.message : "The canvas did not accept the edit.",
          };
        }
        ctx.recordStep(
          `Applied ${operations.length} edit(s); graph has ${Object.keys(graph).length} nodes`,
          "edit_graph",
        );
        return { ok: true, operations: operations.length, nodeCount: Object.keys(graph).length };
      },
    }),

    queue_prompt: tool({
      description:
        "Queue the graph currently on the canvas on the attached ComfyUI server. Only call when the user asks to run/generate.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        // Always queue the live canvas graph (lossless), never a model-supplied
        // reconstruction that could drop or corrupt nodes.
        const report = await refreshComfyCanvasReport(ctx.bridge, ctx.activeEndpointRaw);
        const prompt = report?.prompt;
        if (!prompt || Object.keys(prompt).length === 0) {
          return {
            ok: false,
            error:
              "No graph is available to queue. Ask the user to open the canvas and load a workflow first.",
          };
        }
        ctx.recordStep("Queueing the prompt on the server", "queue_prompt");
        try {
          const promptId = await queueComfyPrompt(ctx.endpoint, prompt, ctx.abortSignal);
          recordComfyJobStarted({
            id: promptId,
            endpoint: ctx.activeEndpointRaw,
            workflow: prompt,
            prompt: extractPromptText(prompt),
          });
          // The user hit Stop in the window between the server accepting the
          // prompt and this returning — cancel it instead of leaving it running.
          if (ctx.abortSignal.aborted) {
            await cancelComfyPrompt(ctx.endpoint, promptId).catch(() => undefined);
            recordComfyJobFinished(ctx.activeEndpointRaw, promptId, "cancelled");
            return { ok: false, error: "The run was stopped before it started." };
          }
          // Detached watcher: drive the job to a terminal state (and cancel it on
          // Stop) so the activity feed never strands a phantom running job.
          void trackComfyAgentJob(ctx.endpoint, ctx.activeEndpointRaw, promptId, ctx.abortSignal);
          ctx.recordStep(`Queued prompt ${promptId}`, "queue_prompt");
          return { ok: true, promptId };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "Queueing failed.",
          };
        }
      },
    }),

    list_model_files: tool({
      description:
        "List model files available on the server for one folder (checkpoints, diffusion_models, vae, loras, text_encoders, clip, clip_vision, controlnet, upscale_models).",
      inputSchema: z.object({
        folder: z.enum(COMFY_MODEL_FOLDERS),
      }),
      execute: async ({ folder }) => {
        ctx.recordStep(`Listing ${folder} models`, "list_model_files");
        try {
          const files = await fetchComfyModelFolder(ctx.endpoint, folder, {
            timeoutMs: 10_000,
          });
          return { ok: true, folder, count: files.length, files };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "Could not list models.",
          };
        }
      },
    }),

    get_server_stats: tool({
      description: "Read system stats from the attached ComfyUI server (version, device, VRAM).",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        ctx.recordStep("Reading server stats", "get_server_stats");
        try {
          const stats = await fetchComfySystemStats(ctx.endpoint, { timeoutMs: 8_000 });
          return { ok: true, stats };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "Could not read server stats.",
          };
        }
      },
    }),
  };
}
