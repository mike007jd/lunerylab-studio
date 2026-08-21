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
import { recordComfyJobStarted } from "@/lib/server/comfy-activity";
import { refreshComfyCanvasReport } from "@/lib/server/comfy-agent/graph-state";
import { loadWorkflowOnCanvas } from "@/lib/server/comfy-agent/canvas-bridge";
import {
  installManagerCustomNode,
  listManagerCustomNodes,
  queueComfyPrompt,
  rebootViaManager,
} from "@/lib/server/comfy-agent/comfy-client";

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

export function buildComfyAgentToolset(ctx: ComfyAgentToolContext) {
  return {
    observe_graph: tool({
      description:
        "Read the user's current ComfyUI graph from the canvas window. Call this before any edit and whenever you need current state.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        ctx.recordStep("Reading the live graph", "observe_graph");
        const report = await refreshComfyCanvasReport(ctx.bridge);
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
        "Replace the canvas graph with a modified API-format workflow. Submit the COMPLETE workflow; unrelated nodes must be preserved verbatim.",
      inputSchema: z.object({
        workflow: z.record(
          z.string(),
          z.object({
            class_type: z.string().min(1),
            inputs: z.record(z.string(), z.unknown()).optional(),
            _meta: z.unknown().optional(),
          }),
        ),
      }),
      execute: async ({ workflow }) => {
        ctx.recordStep("Applying the edited graph", "edit_graph");
        try {
          await loadWorkflowOnCanvas(ctx.bridge, workflow);
        } catch (error) {
          return {
            ok: false,
            error:
              error instanceof Error ? error.message : "The canvas did not accept the workflow.",
          };
        }
        ctx.recordStep(`Loaded ${Object.keys(workflow).length} nodes onto the canvas`, "edit_graph");
        return { ok: true, nodeCount: Object.keys(workflow).length };
      },
    }),

    queue_prompt: tool({
      description:
        "Queue a workflow on the attached ComfyUI server. Without an argument it queues the graph currently on the canvas. Only call when the user asks to run/generate.",
      inputSchema: z.object({
        workflow: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async ({ workflow }) => {
        let prompt = workflow;
        if (!prompt) {
          const report = await refreshComfyCanvasReport(ctx.bridge);
          prompt = report?.prompt;
        }
        if (!prompt || Object.keys(prompt).length === 0) {
          return {
            ok: false,
            error: "No graph is available to queue. Open the canvas or provide a workflow.",
          };
        }
        ctx.recordStep("Queueing the prompt on the server", "queue_prompt");
        try {
          const promptId = await queueComfyPrompt(ctx.endpoint, prompt);
          recordComfyJobStarted({
            id: promptId,
            endpoint: ctx.activeEndpointRaw,
            workflow: prompt,
            prompt: extractPromptText(prompt),
          });
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

    list_custom_nodes: tool({
      description:
        "List custom nodes installed on the server via ComfyUI-Manager. Reports available:false when Manager is absent.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        ctx.recordStep("Listing installed custom nodes", "list_custom_nodes");
        try {
          const result = await listManagerCustomNodes(ctx.endpoint);
          return { ok: true, managerAvailable: result.available, nodes: result.nodes };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "Could not list custom nodes.",
          };
        }
      },
    }),

    install_custom_node: tool({
      description:
        "Install a custom node on the server through ComfyUI-Manager. The download runs in the server's background; a reboot may be needed afterwards.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(200),
      }),
      execute: async ({ name }) => {
        ctx.recordStep(`Installing custom node "${name}"`, "install_custom_node");
        try {
          const result = await installManagerCustomNode(ctx.endpoint, name);
          return { ok: result.ok, detail: result.detail };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "Install failed.",
          };
        }
      },
    }),

    reboot_server: tool({
      description:
        "Reboot the attached ComfyUI server via ComfyUI-Manager (needed after some installs). Ask the user before calling this.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        ctx.recordStep("Rebooting the server via Manager", "reboot_server");
        try {
          const result = await rebootViaManager(ctx.endpoint);
          return { ok: result.ok, detail: result.detail };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "Reboot failed.",
          };
        }
      },
    }),
  };
}
