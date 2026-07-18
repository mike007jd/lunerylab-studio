"use client";

import { useCallback, useMemo } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AgentChatUIProvider,
  type AgentChatUI,
} from "@/components/studio/agent-chat/agent-message-parts";
import { AgentThread } from "@/components/studio/agent-chat/agent-thread";
import type { UseAgentChat } from "@/components/studio/agent-chat/use-agent-chat";
import { getAgentMessageText } from "@/components/studio/agent-chat/agent-chat-types";

export interface AgentChatPanelProps {
  /** Chat state + actions, owned by the caller via `useAgentChat`. */
  chat: UseAgentChat;
  /** Click a generated thumbnail to focus that asset's layer on the canvas. */
  onFocusAsset?: (assetId: string) => void;
  /** Resolves a persisted chat asset against current Canvas layers. */
  isAssetAvailable?: (assetId: string) => boolean;
  showGenerationOptions?: boolean;
  className?: string;
}

/**
 * Canvas agent chat panel, backed by the `assistant-ui` runtime + primitives.
 * State lives in the caller's `useAgentChat` hook; the assistant-ui AI SDK
 * adapter owns message conversion, streaming state, aborts, and retries.
 */
export function AgentChatPanel({
  chat,
  onFocusAsset,
  isAssetAvailable,
  showGenerationOptions = true,
  className,
}: AgentChatPanelProps) {
  const { sendMessage } = chat;
  const runtime = useAISDKRuntime(chat.sdkChat);
  chat.transport.setRuntime(runtime);

  // Re-send the most recent user message after a failed turn (powers the
  // inline Retry button on error parts).
  const onRetry = useCallback(() => {
    const lastUser = chat.messages.findLast((m) => m.role === "user");
    const text = lastUser ? getAgentMessageText(lastUser) : "";
    if (text) void sendMessage(text);
  }, [chat.messages, sendMessage]);

  const ui = useMemo<AgentChatUI>(
    () => ({
      options: chat.options,
      setOptions: chat.setOptions,
      showGenerationOptions,
      onFocusAsset,
      isAssetAvailable,
      onRetry,
    }),
    [
      chat.options,
      chat.setOptions,
      showGenerationOptions,
      onFocusAsset,
      isAssetAvailable,
      onRetry,
    ],
  );

  return (
    <div
      data-testid="agent-chat-panel"
      className={cn("flex h-full flex-col overflow-hidden bg-background", className)}
    >
      <AssistantRuntimeProvider runtime={runtime}>
        <TooltipProvider>
          <AgentChatUIProvider value={ui}>
            <div className="min-h-0 flex-1">
              <AgentThread />
            </div>
          </AgentChatUIProvider>
        </TooltipProvider>
      </AssistantRuntimeProvider>
    </div>
  );
}
