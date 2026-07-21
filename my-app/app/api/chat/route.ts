import { z } from "zod";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { UIMessageStreamWriter } from "ai";
import { detectLocaleFromAcceptLanguage, normalizeLocale } from "@/lib/i18n/locale";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { ApiError, jsonError, toApiError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import { runAgent } from "@/lib/server/agent/runtime/run";
import type { AgentRunResult } from "@/lib/server/agent/runtime/run";
import type { AgentUiContext, AgentMarkedRegion } from "@/lib/server/agent/types";
import { createRouteTelemetry } from "@/lib/server/route-telemetry";
import {
  createAgentTask,
  failAgentTask,
  finishAgentTask,
  persistAgentTaskStep,
} from "@/lib/server/agent/task-store";

export const maxDuration = 300;

function parseUiContext(raw: unknown): AgentUiContext {
  const value = (raw ?? {}) as Record<string, unknown>;
  // No hardcoded fallback model: an empty id means "nothing selected", and the
  // generation tools surface a clear configure-a-model error downstream.
  const selectedModelId =
    typeof value.selectedModelId === "string" && value.selectedModelId.trim()
      ? value.selectedModelId.trim()
      : "";
  const selectedAspectRatio =
    typeof value.selectedAspectRatio === "string" && value.selectedAspectRatio.trim()
      ? value.selectedAspectRatio.trim()
      : "1:1";
  const selectedCount = Number(value.selectedCount);
  const generationMode = value.generationMode === "video" ? "video" : "image";

  return {
    selectedTextModelId:
      typeof value.selectedTextModelId === "string" ? value.selectedTextModelId.trim() : "",
    selectedModelId,
    selectedAspectRatio,
    selectedCount: Number.isFinite(selectedCount) ? Math.max(1, Math.min(4, Math.round(selectedCount))) : 1,
    generationMode,
  };
}

function parseRegion(raw: unknown): AgentMarkedRegion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { positionHint?: unknown; bbox?: Record<string, unknown> };
  const b = r.bbox ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    positionHint: typeof r.positionHint === "string" ? r.positionHint : "the marked area",
    bbox: { x: num(b.x), y: num(b.y), width: num(b.width), height: num(b.height) },
  };
}

function parseOptionalString(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function readTextPart(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const value = part as { type?: unknown; text?: unknown };
  return value.type === "text" && typeof value.text === "string" ? value.text : "";
}

function readLatestUserMessage(messages: unknown): {
  text: string;
  parts: Array<Record<string, unknown>>;
} | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; parts?: unknown };
    if (message?.role !== "user" || !Array.isArray(message.parts)) continue;
    const text = message.parts.map(readTextPart).join("\n").trim();
    if (text) return { text, parts: message.parts as Array<Record<string, unknown>> };
  }
  return null;
}

type AgentChatAction =
  | { type: "inpaint_layer"; layerId: string; prompt: string }
  | { type: "remove_background"; layerId: string };

const agentActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inpaint_layer"),
    layerId: z.string().min(1),
    prompt: z.string().min(1),
  }),
  z.object({
    type: z.literal("remove_background"),
    layerId: z.string().min(1),
  }),
]);

function parseAction(raw: unknown): AgentChatAction | undefined {
  return raw === undefined || raw === null ? undefined : agentActionSchema.parse(raw);
}

function writeText(
  writer: UIMessageStreamWriter,
  text: string,
  id = "agent-final",
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  writer.write({ type: "text-start", id });
  writer.write({ type: "text-delta", id, delta: trimmed });
  writer.write({ type: "text-end", id });
}

function writeResultParts(
  writer: UIMessageStreamWriter,
  result: AgentRunResult,
  textAlreadyStreamed = false,
  taskId?: string,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (result.error) {
    parts.push({ type: "data-agent-error", id: "agent-error", data: result.error });
    writer.write({
      type: "data-agent-error",
      id: "agent-error",
      data: result.error,
    });
  }
  if (result.assistantMessage.trim()) {
    parts.push({ type: "text", text: result.assistantMessage.trim() });
  }
  if (!textAlreadyStreamed) writeText(writer, result.assistantMessage);
  for (const assetId of result.artifacts.generatedAssetIds ?? []) {
    const data = { id: assetId, url: `/api/assets/${assetId}` };
    parts.push({ type: "data-agent-asset", id: assetId, data });
    writer.write({
      type: "data-agent-asset",
      id: assetId,
      data,
    });
  }
  if (result.capabilityFix) {
    parts.push({
      type: "data-agent-capability-fix",
      id: "agent-capability-fix",
      data: result.capabilityFix,
    });
    writer.write({
      type: "data-agent-capability-fix",
      id: "agent-capability-fix",
      data: result.capabilityFix,
    });
  }
  if (result.beforeSnapshotId && result.steps.length > 0 && taskId) {
    const data = { taskId, undoAvailable: true };
    parts.push({ type: "data-agent-task", id: "agent-task", data });
    writer.write({ type: "data-agent-task", id: "agent-task", data });
  }
  const backendData = {
    llm: result.backendUsed.llm,
    image: result.backendUsed.image,
    generationBackend: result.generationBackend,
  };
  parts.push({ type: "data-agent-backend", id: "agent-backend", data: backendData });
  writer.write({
    type: "data-agent-backend",
    id: "agent-backend",
    data: backendData,
  });
  return parts;
}

// Mirrors the handler's prior `as {…}` cast and its runtime tolerance: scalar
// fields are re-`trim()`'d below (so nullable strings) and uiContext/region/
// maskAssetId flow through their own defensive parsers, so they stay `unknown`.
// `.passthrough()` keeps the old behaviour of ignoring extra keys; parseJsonBody
// only adds a fast 400 for a non-object body.
const agentChatBodySchema = z
  .object({
    sessionId: z.string().nullish(),
    message: z.string().nullish(),
    messages: z.unknown().optional(),
    selectedLayerId: z.string().nullish(),
    uiContext: z.unknown().optional(),
    region: z.unknown().optional(),
    maskAssetId: z.unknown().optional(),
    action: z.unknown().optional(),
    locale: z.string().nullish(),
  })
  .passthrough();

export async function POST(request: Request) {
  const telemetry = createRouteTelemetry("/api/chat", request);
  telemetry.start();

  try {
    const user = await requireLocalWorkspaceOwner();

    const body = await parseJsonBody(request, agentChatBodySchema);

    const sessionId = body.sessionId?.trim();
    const latestUserMessage = readLatestUserMessage(body.messages);
    const message = body.message?.trim() || latestUserMessage?.text;
    const action = parseAction(body.action);
    // An action-only request (e.g. inpaint a marked region, remove background)
    // is valid without a text message — the deterministic tool needs no prompt.
    if (!sessionId || (!message && !action)) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "Provide sessionId and a message or action.",
        retryable: false,
      });
    }

    const locale =
      normalizeLocale(body.locale) ??
      detectLocaleFromAcceptLanguage(request.headers.get("accept-language"));
    const uiContext = parseUiContext(body.uiContext);
    const region = parseRegion(body.region);
    const selectedLayerId = body.selectedLayerId?.trim() || null;
    const maskAssetId = parseOptionalString(body.maskAssetId);
    const task = await createAgentTask({
      userId: user.id,
      sessionId,
      prompt: message ?? action?.type ?? "Canvas action",
      selectedLayerId,
      textModelId: uiContext.selectedTextModelId,
      uiContext,
      action,
      userParts: latestUserMessage?.parts ?? [{ type: "text", text: message ?? action?.type ?? "Canvas action" }],
    });

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({
          type: "data-agent-status",
          id: "agent-status",
          data: { status: "running" },
        });
        try {
          const stepWrites: Array<Promise<void>> = [];
          let textStarted = false;
          const agentResult = await runAgent({
            taskId: task.id,
            userId: user.id,
            sessionId,
            message: message ?? "",
            selectedLayerId,
            uiContext,
            locale,
            region,
            maskAssetId,
            action,
            abortSignal: request.signal,
            onStep: (step) => {
              stepWrites.push(persistAgentTaskStep(task.id, step));
              writer.write({
                type: "data-agent-step",
                id: step.id,
                data: {
                  id: step.id,
                  summary: step.summary,
                  toolName: step.toolName,
                },
              });
            },
            onTextDelta: (delta) => {
              if (!delta) return;
              if (!textStarted) {
                textStarted = true;
                writer.write({ type: "text-start", id: "agent-final" });
              }
              writer.write({ type: "text-delta", id: "agent-final", delta });
            },
          });
          if (textStarted) writer.write({ type: "text-end", id: "agent-final" });
          await Promise.all(stepWrites);
          const assistantParts = writeResultParts(writer, agentResult, textStarted, task.id);
          await finishAgentTask({
            taskId: task.id,
            result: agentResult,
            assistantParts,
            cancelled: request.signal.aborted,
          });
          writer.write({
            type: "data-agent-status",
            id: "agent-status",
            data: { status: agentResult.error ? "error" : "complete" },
          });
          writer.write({
            type: "finish",
            finishReason: agentResult.error ? "error" : "stop",
          });
        } catch (err) {
          const apiErr = toApiError(err);
          const errorParts = [
            { type: "data-agent-error", id: "agent-error", data: { code: apiErr.code, message: apiErr.message } },
            { type: "text", text: apiErr.message },
          ];
          await failAgentTask(
            task.id,
            { code: apiErr.code, message: apiErr.message },
            { assistantParts: errorParts, cancelled: request.signal.aborted },
          ).catch(() => {});
          writer.write({
            type: "data-agent-error",
            id: "agent-error",
            data: { code: apiErr.code, message: apiErr.message },
          });
          writeText(writer, apiErr.message, "agent-error-text");
          writer.write({
            type: "data-agent-status",
            id: "agent-status",
            data: { status: "error" },
          });
          writer.write({ type: "finish", finishReason: "error" });
        }
      },
    });
    const response = createUIMessageStreamResponse({
      status: 200,
      stream,
      headers: { "cache-control": "no-cache, no-transform" },
    });
    telemetry.done(response.status);
    return response;
  } catch (error) {
    telemetry.failed(error);
    return jsonError(error);
  }
}
