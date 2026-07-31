"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useChat, type UseChatHelpers } from "@ai-sdk/react";
import { AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { useI18n } from "@/lib/i18n/provider";
import type { Locale } from "@/lib/i18n/locale";
import type { GenerationOptions } from "@/lib/constants/generation";
import { fetchJson } from "@/lib/client/fetch-json";
import type { ImageModelEntry } from "@/lib/image-models";
import { findByokProvider, type ByokConnectionModels } from "@/lib/byok-providers";
import {
  AGENT_MODEL_ROUTING_AUTO,
  resolveAgentImageModelId,
  resolveAgentTextModelId,
  type AgentModelRouting,
  type AgentModelRoutingOption,
} from "./agent-message-parts";
import type {
  AgentChatAction,
  AgentChatMessage,
} from "./agent-chat-types";

interface UseAgentChatArgs {
  sessionId: string;
  /** The currently-selected canvas layer, threaded into the agent request. */
  selectedLayerId?: string | null;
  selectedModelId: string;
  selectedTextModelId?: string;
  generationMode?: "image" | "video";
}

export interface UseAgentChat {
  sdkChat: UseChatHelpers<AgentChatMessage>;
  transport: AssistantChatTransport<AgentChatMessage>;
  messages: AgentChatMessage[];
  isRunning: boolean;
  options: GenerationOptions;
  /**
   * Raw React state setter — accepts a value or a functional updater. Callers
   * updating a single field should prefer the functional form
   * (`setOptions((prev) => ({ ...prev, field }))`) so the handler doesn't close
   * over the current `options` snapshot on every render.
   */
  setOptions: Dispatch<SetStateAction<GenerationOptions>>;
  /**
   * Stable across renders — safe to call from memoised canvas action handlers
   * (inpaint / remove-bg) without a `sendMessageRef` dance. Reads
   * the latest options + selected layer through refs.
   */
  sendMessage: (
    content: string,
    opts?: { maskAssetId?: string | null; action?: AgentChatAction },
  ) => Promise<void>;
  /** Abort the in-flight run (bidirectional: closes the fetch + signals server). */
  stop: () => void;
}

function createErrorMessage(text: string, code?: string): AgentChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [
      {
        type: "data-agent-error",
        id: "agent-error",
        data: { code, message: text },
      },
      { type: "text", text },
    ],
  };
}

function appendVisibleError(
  setMessages: UseChatHelpers<AgentChatMessage>["setMessages"],
  text: string,
  code?: string,
): void {
  setMessages((prev) => {
    const last = prev.at(-1);
    const alreadyVisible =
      last?.role === "assistant" &&
      last.parts.some(
        (part) =>
          part.type === "data-agent-error" &&
          typeof part.data === "object" &&
          part.data !== null &&
          "message" in part.data &&
          part.data.message === text,
      );
    return alreadyVisible ? prev : [...prev, createErrorMessage(text, code)];
  });
}

export function mergeAgentThreadHistory(
  history: AgentChatMessage[],
  current: AgentChatMessage[],
): AgentChatMessage[] {
  const liveIds = new Set(current.map((message) => message.id));
  const missingHistory = history.filter((message) => !liveIds.has(message.id));
  return missingHistory.length > 0 ? [...missingHistory, ...current] : current;
}

export function buildUiContext(
  options: GenerationOptions,
  selectedModelId: string,
  selectedTextModelId: string,
  generationMode: "image" | "video",
) {
  return {
    selectedTextModelId,
    selectedModelId,
    selectedAspectRatio: options.aspectRatio,
    selectedCount: options.count,
    generationMode,
  };
}

// ---------------------------------------------------------------------------
// Per-capability model routing (Auto = persisted Settings defaults, Manual =
// explicit live picks). The selection shape lives in agent-message-parts.tsx
// next to the composer UI; this hook owns the state and resolves the exact
// ids sent in uiContext. The server contract is unchanged: "" means "no model
// configured" and no fallback id is ever invented.
// ---------------------------------------------------------------------------

/**
 * Live text options: the currently-loaded local runtime model plus every
 * configured BYOK connection's text slot. Ids use the server contract formats
 * (`local:<id>`, `byok:<providerId>:<modelId>`) — no catalog constants.
 */
export function buildAgentTextModelOptions({
  providerConnections,
  providers,
  localTextModelId,
  localTextModelLabel,
  localSourceLabel,
}: {
  providerConnections: Record<string, { models?: ByokConnectionModels }>;
  providers: Record<string, { configured: boolean; source?: "keychain" | null }>;
  localTextModelId?: string | null;
  localTextModelLabel?: string | null;
  localSourceLabel: string;
}): AgentModelRoutingOption[] {
  const options: AgentModelRoutingOption[] = [];
  const localId = localTextModelId?.trim();
  if (localId) {
    options.push({
      id: `local:${localId}`,
      label: `${localSourceLabel} · ${localTextModelLabel?.trim() || localId}`,
    });
  }
  for (const [providerId, connection] of Object.entries(providerConnections)) {
    const modelId = connection.models?.text?.trim();
    if (!modelId || providers[providerId]?.configured !== true) continue;
    const providerLabel = findByokProvider(providerId)?.label ?? providerId;
    options.push({ id: `byok:${providerId}:${modelId}`, label: `${providerLabel} · ${modelId}` });
  }
  return options;
}

/** Live image options straight from the shared model catalog snapshot. */
export function buildAgentImageModelOptions(
  models: ImageModelEntry[],
  preferZh: boolean,
): AgentModelRoutingOption[] {
  return models.map((model) => ({
    id: model.id,
    label: preferZh ? model.labelZh : model.label,
  }));
}

/**
 * Owns the Auto/Manual routing state for the canvas agent chat. Every slot
 * starts on the Auto sentinel; the composer UI flips slots to Manual by
 * pinning a concrete live option (see ModelRoutingBar in agent-thread.tsx).
 */
export function useAgentModelRouting({
  defaultTextModelId,
  defaultImageModelId,
  textOptions,
  imageOptions,
  imageCatalogLoaded,
}: {
  defaultTextModelId: string;
  defaultImageModelId: string;
  textOptions: AgentModelRoutingOption[];
  imageOptions: AgentModelRoutingOption[];
  /** False until the shared model catalog first resolves — Auto image ids are trusted until it lands. */
  imageCatalogLoaded: boolean;
}): AgentModelRouting {
  const [textSelection, setTextSelection] = useState<string>(AGENT_MODEL_ROUTING_AUTO);
  const [imageSelection, setImageSelection] = useState<string>(AGENT_MODEL_ROUTING_AUTO);

  const textModelId = resolveAgentTextModelId(textSelection, defaultTextModelId, textOptions);
  const imageModelId = resolveAgentImageModelId(
    imageSelection,
    defaultImageModelId.trim(),
    imageCatalogLoaded ? imageOptions : null,
  );

  return useMemo(
    () => ({
      textSelection,
      imageSelection,
      onTextSelectionChange: setTextSelection,
      onImageSelectionChange: setImageSelection,
      textOptions,
      imageOptions,
      autoTextModelId: defaultTextModelId,
      autoImageModelId: defaultImageModelId,
      textModelId,
      imageModelId,
    }),
    [
      defaultImageModelId,
      defaultTextModelId,
      imageModelId,
      imageOptions,
      imageSelection,
      textModelId,
      textOptions,
      textSelection,
    ],
  );
}

interface AgentRequestContext {
  sessionId: string;
  selectedLayerId: string | null;
  selectedModelId: string;
  selectedTextModelId: string;
  generationMode: "image" | "video";
  options: GenerationOptions;
  locale: Locale;
}

class AgentChatTransportWithContext extends AssistantChatTransport<AgentChatMessage> {
  private readonly context: { current: AgentRequestContext };

  constructor(initialContext: AgentRequestContext) {
    const context = { current: initialContext };
    super({
      prepareSendMessagesRequest: ({
        id,
        messages,
        trigger,
        messageId,
        requestMetadata,
        body,
      }) => {
        const bodyRecord =
          body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        const current = context.current;

        return {
          body: {
            ...bodyRecord,
            id,
            messages,
            trigger,
            messageId,
            metadata: requestMetadata,
            sessionId: current.sessionId,
            locale: current.locale,
            selectedLayerId: current.selectedLayerId,
            uiContext: buildUiContext(
              current.options,
              current.selectedModelId,
              current.selectedTextModelId,
              current.generationMode,
            ),
          },
        };
      },
    });
    this.context = context;
  }

  setRequestContext(next: AgentRequestContext): void {
    this.context.current = next;
  }
}

/**
 * Owns the canvas-agent chat state while delegating the transport and stream
 * parsing to the AI SDK UIMessage protocol.
 */
export function useAgentChat({
  sessionId,
  selectedLayerId,
  selectedModelId,
  selectedTextModelId = "",
  generationMode = "image",
}: UseAgentChatArgs): UseAgentChat {
  const [options, setOptions] = useState<GenerationOptions>({
    aspectRatio: "auto",
    count: 1,
  });

  const { locale, t } = useI18n();
  const [transport] = useState(
    () =>
      new AgentChatTransportWithContext({
        sessionId,
        selectedLayerId: selectedLayerId || null,
        selectedModelId,
        selectedTextModelId,
        generationMode,
        options,
        locale,
      }),
  );
  useEffect(() => {
    transport.setRequestContext({
      sessionId,
      selectedLayerId: selectedLayerId || null,
      selectedModelId,
      selectedTextModelId,
      generationMode,
      options,
      locale,
    });
  }, [generationMode, locale, options, selectedLayerId, selectedModelId, selectedTextModelId, sessionId, transport]);

  const chat = useChat<AgentChatMessage>({
    id: sessionId,
    transport,
    experimental_throttle: 50,
    onError: (err) => {
      const aborted = err.name === "AbortError";
      const text = aborted ? t("agent.stopped") : err.message;
      appendVisibleError(chat.setMessages, text);
    },
  });
  const setChatMessages = chat.setMessages;

  const hydratedSessionRef = useRef("");
  useEffect(() => {
    if (hydratedSessionRef.current === sessionId) return;
    hydratedSessionRef.current = sessionId;
    let active = true;

    void fetchJson<{ messages: AgentChatMessage[] }>(
      `/api/canvas/sessions/${encodeURIComponent(sessionId)}/agent-thread`,
      { cache: "no-store" },
    )
      .then(({ messages }) => {
        if (!active || messages.length === 0) return;
        setChatMessages((current) => mergeAgentThreadHistory(messages, current));
      })
      .catch(() => {
        // A history read failure must not disable a fresh conversation. Any
        // send failure is still rendered by the transport's visible error.
      });

    return () => {
      active = false;
    };
  }, [sessionId, setChatMessages]);

  const sendInFlightRef = useRef(false);
  const [sendPending, setSendPending] = useState(false);
  const isRunning = sendPending || chat.status === "submitted" || chat.status === "streaming";

  const sendMessage = useCallback(
    async (
      content: string,
      opts: { maskAssetId?: string | null; action?: AgentChatAction } = {},
    ) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      // React status updates are asynchronous. The ref closes the same-tick
      // double-click window before a second paid agent run can start.
      if (
        sendInFlightRef.current ||
        chat.status === "submitted" ||
        chat.status === "streaming"
      ) {
        return;
      }
      sendInFlightRef.current = true;
      setSendPending(true);

      try {
        await chat.sendMessage(
          { text: trimmed },
          {
            body: {
              maskAssetId: opts.maskAssetId ?? null,
              action: opts.action,
            },
          },
        );
      } catch (err) {
        const aborted = (err as Error).name === "AbortError";
        const text = aborted ? t("agent.stopped") : (err as Error).message;
        appendVisibleError(chat.setMessages, text);
      } finally {
        sendInFlightRef.current = false;
        setSendPending(false);
      }
    },
    [chat, t],
  );

  return {
    sdkChat: chat,
    transport,
    messages: chat.messages,
    isRunning,
    options,
    setOptions,
    sendMessage,
    stop: chat.stop,
  };
}
