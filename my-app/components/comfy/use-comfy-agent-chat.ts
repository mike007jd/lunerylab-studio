"use client";

// Chat state for the ComfyUI workspace agent ("Luna for Comfy").
//
// Mirrors the canvas agent transport pattern: an AssistantChatTransport that
// injects per-request context (connectionId, locale) into every send body,
// with the AI SDK UIMessage protocol owning streaming and parsing.
// Conversations are intentionally session-less — they live for the page visit.

import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "@ai-sdk/react";
import { AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { useI18n } from "@/lib/i18n/provider";
import type { Locale } from "@/lib/i18n/locale";

export interface ComfyAgentRunStep {
  id: string;
  summary: string;
  toolName?: string;
}

export interface ComfyAgentChatError {
  code?: string;
  message: string;
}

export interface ComfyAgentDataParts {
  [key: string]: unknown;
  "agent-status": { status: "running" | "complete" | "error" };
  "agent-step": ComfyAgentRunStep;
  "agent-backend": { llm: string };
  "agent-error": ComfyAgentChatError;
}

export type ComfyAgentChatMessage = UIMessage<unknown, ComfyAgentDataParts>;

interface ComfyAgentRequestContext {
  connectionId: string | null;
  locale: Locale;
}

class ComfyAgentTransport extends AssistantChatTransport<ComfyAgentChatMessage> {
  private readonly context: { current: ComfyAgentRequestContext };

  constructor(initialContext: ComfyAgentRequestContext) {
    const context = { current: initialContext };
    super({
      api: "/api/comfy/agent",
      prepareSendMessagesRequest: ({ id, messages, trigger, messageId, requestMetadata, body }) => {
        const bodyRecord =
          body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        return {
          body: {
            ...bodyRecord,
            id,
            messages,
            trigger,
            messageId,
            metadata: requestMetadata,
            connectionId: context.current.connectionId,
            locale: context.current.locale,
          },
        };
      },
    });
    this.context = context;
  }

  setRequestContext(next: ComfyAgentRequestContext): void {
    this.context.current = next;
  }
}

function appendVisibleError(
  setMessages: (updater: (messages: ComfyAgentChatMessage[]) => ComfyAgentChatMessage[]) => void,
  message: string,
): void {
  setMessages((current) => [
    ...current,
    {
      id: `agent-error-${Date.now()}`,
      role: "assistant",
      parts: [{ type: "data-agent-error", data: { message } }],
    } as ComfyAgentChatMessage,
  ]);
}

export function useComfyAgentChat({ connectionId }: { connectionId: string | null }) {
  const { locale, t } = useI18n();
  const [transport] = useState(
    () => new ComfyAgentTransport({ connectionId, locale }),
  );
  useEffect(() => {
    transport.setRequestContext({ connectionId, locale });
  }, [connectionId, locale, transport]);

  const chat = useChat<ComfyAgentChatMessage>({
    transport,
    experimental_throttle: 50,
    onError: (err) => {
      const aborted = err.name === "AbortError";
      appendVisibleError(
        chat.setMessages,
        aborted ? t("comfy.agent.stopped") : err.message,
      );
    },
  });
  const inFlightRef = useRef(false);

  const sendMessage = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (!trimmed || inFlightRef.current) return false;
      inFlightRef.current = true;
      chat.sendMessage({ text: trimmed }).finally(() => {
        inFlightRef.current = false;
      });
      return true;
    },
    [chat],
  );

  return {
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    stop: chat.stop,
    regenerate: chat.regenerate,
    setMessages: chat.setMessages,
    sendMessage,
  };
}
