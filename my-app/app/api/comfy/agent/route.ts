// ComfyUI workspace agent ("Luna for Comfy").
//
// Same UIMessage stream protocol as /api/chat (data-agent-status/step/error/
// backend parts) but a ComfyUI-specific toolset: the agent reads and edits the
// live graph on the native canvas window, queues runs on the attached server,
// lists model files, and installs custom nodes through ComfyUI-Manager.
//
// Model supply follows the platform rule: the Settings-selected text model
// only — no default, no fallback. Nothing configured fails before the stream
// starts with a typed 503.

import { NextResponse } from "next/server";
import { z } from "zod";
import { stepCountIs, streamText } from "ai";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  detectLocaleFromAcceptLanguage,
  normalizeLocale,
  type Locale,
} from "@/lib/i18n/locale";
import {
  requireLocalWorkspaceOwner,
  getLocalWorkspacePreferences,
} from "@/lib/server/local-workspace-owner";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { ensureWorkspaceRestoreReconciled } from "@/lib/server/workspace-restore-journal";
import { ApiError, jsonError, toApiError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import {
  getActiveComfyConnection,
  getComfyConnection,
} from "@/lib/server/comfy-connection-store";
import { validateComfyEndpoint } from "@/lib/server/comfy-endpoint";
import { resolveStudioRuntimeSupply } from "@/lib/server/runtime-supply";
import { resolveAgentLanguageModel } from "@/lib/server/agent/runtime/resolve-language-model";
import { buildComfyAgentSystemPrompt } from "@/lib/server/comfy-agent/system-prompt";
import {
  buildComfyAgentToolset,
  type ComfyAgentToolContext,
} from "@/lib/server/comfy-agent/tools";

export const maxDuration = 120;

const MAX_STEPS = 10;

const agentBodySchema = z
  .object({
    messages: z.unknown().optional(),
    connectionId: z.string().trim().min(1).nullish(),
    locale: z.string().nullish(),
  })
  .passthrough();

function readTextPart(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const value = part as { type?: unknown; text?: unknown };
  return value.type === "text" && typeof value.text === "string" ? value.text : "";
}

function readLatestUserMessage(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; parts?: unknown };
    if (message?.role !== "user" || !Array.isArray(message.parts)) continue;
    const text = message.parts.map(readTextPart).join("\n").trim();
    if (text) return text;
  }
  return null;
}

const MAX_HISTORY_MESSAGES = 20;

interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Convert the client's UIMessage history to plain model messages so follow-ups
 * ("make that stronger", "yes, run it") keep the prior workflow and intent.
 * Only text is carried — the UI-only data parts (step/error/backend) are
 * dropped — and the tail is capped to bound the prompt.
 */
function readConversation(messages: unknown): ModelMessage[] {
  if (!Array.isArray(messages)) return [];
  const history: ModelMessage[] = [];
  for (const raw of messages) {
    const message = raw as { role?: unknown; parts?: unknown };
    if ((message?.role !== "user" && message?.role !== "assistant") || !Array.isArray(message.parts)) {
      continue;
    }
    const content = message.parts.map(readTextPart).join("").trim();
    if (content) history.push({ role: message.role, content });
  }
  return history.slice(-MAX_HISTORY_MESSAGES);
}

export async function POST(request: Request) {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;
    await ensureWorkspaceRestoreReconciled();
    const user = await requireLocalWorkspaceOwner();

    const body = await parseJsonBody(request, agentBodySchema);
    const userText = readLatestUserMessage(body.messages);
    const conversation = readConversation(body.messages);
    if (!userText) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "Provide a message for the ComfyUI agent.",
        retryable: false,
      });
    }

    const locale: Locale =
      normalizeLocale(body.locale) ??
      detectLocaleFromAcceptLanguage(request.headers.get("accept-language")) ??
      "en";

    const connection = body.connectionId
      ? getComfyConnection(body.connectionId)
      : getActiveComfyConnection();
    if (!connection) {
      throw new ApiError({
        status: 400,
        code: "no_connection",
        message: "Attach a ComfyUI server before using the agent.",
        retryable: false,
      });
    }
    const endpointCheck = await validateComfyEndpoint(connection.endpoint);
    if ("error" in endpointCheck) {
      throw new ApiError({
        status: 400,
        code: "invalid_endpoint",
        message: endpointCheck.error,
        retryable: false,
      });
    }

    // Explicit selection only: an empty Settings pick means "not configured".
    const settings = await getLocalWorkspacePreferences(user.id);
    const supply = await resolveStudioRuntimeSupply({
      textModelId: settings.defaultTextModel.trim() || undefined,
    });
    if (supply.text.backend === "none") {
      throw new ApiError({
        status: 503,
        code: "llm_backend_missing",
        message:
          locale.startsWith("zh")
            ? "还没有可用的文本模型。请到 设置 → 模型供应 里选择一个文本模型。"
            : "No text model is configured. Open Settings → Model supply and pick a text model.",
        retryable: false,
      });
    }
    const { model } = await resolveAgentLanguageModel(supply);

    // Tool steps stream as data parts; the writer only exists inside the
    // stream body, so tools publish through this slot.
    let emitStep: ((summary: string, toolName: string) => void) | null = null;
    let stepIndex = 0;
    const toolContext: ComfyAgentToolContext = {
      bridge,
      endpoint: endpointCheck,
      activeEndpointRaw: connection.endpoint,
      abortSignal: request.signal,
      recordStep: (summary, toolName) => {
        emitStep?.(summary, toolName);
      },
    };

    const result = streamText({
      model,
      system: buildComfyAgentSystemPrompt({ locale, connectionName: connection.name }),
      messages:
        conversation.length > 0 ? conversation : [{ role: "user", content: userText }],
      tools: buildComfyAgentToolset(toolContext),
      stopWhen: stepCountIs(MAX_STEPS),
      temperature: 0.3,
      maxOutputTokens: 4096,
      abortSignal: request.signal,
    });

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({
          type: "data-agent-status",
          id: "agent-status",
          data: { status: "running" },
        });
        emitStep = (summary, toolName) => {
          stepIndex += 1;
          writer.write({
            type: "data-agent-step",
            id: `agent-step-${stepIndex}`,
            data: { id: `agent-step-${stepIndex}`, summary, toolName },
          });
        };
        let textStarted = false;
        try {
          for await (const part of result.fullStream) {
            if (part.type === "text-delta" && part.text) {
              if (!textStarted) {
                textStarted = true;
                writer.write({ type: "text-start", id: "agent-final" });
              }
              writer.write({ type: "text-delta", id: "agent-final", delta: part.text });
            }
          }
          if (textStarted) writer.write({ type: "text-end", id: "agent-final" });
          writer.write({
            type: "data-agent-backend",
            id: "agent-backend",
            data: { llm: supply.backendUsed.llm },
          });
          writer.write({
            type: "data-agent-status",
            id: "agent-status",
            data: { status: "complete" },
          });
          writer.write({ type: "finish", finishReason: "stop" });
        } catch (err) {
          if (textStarted) writer.write({ type: "text-end", id: "agent-final" });
          const apiErr = toApiError(err);
          writer.write({
            type: "data-agent-error",
            id: "agent-error",
            data: { code: apiErr.code, message: apiErr.message },
          });
          writer.write({ type: "text-start", id: "agent-error-text" });
          writer.write({
            type: "text-delta",
            id: "agent-error-text",
            delta: apiErr.message,
          });
          writer.write({ type: "text-end", id: "agent-error-text" });
          writer.write({
            type: "data-agent-status",
            id: "agent-status",
            data: { status: "error" },
          });
          writer.write({ type: "finish", finishReason: "error" });
        } finally {
          emitStep = null;
        }
      },
    });

    return createUIMessageStreamResponse({
      status: 200,
      stream,
      headers: { "cache-control": "no-cache, no-transform" },
    });
  } catch (error) {
    return jsonError(error);
  }
}
