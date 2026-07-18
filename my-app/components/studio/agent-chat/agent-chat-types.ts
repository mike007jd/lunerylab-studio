import type { UIMessage } from "@ai-sdk/react";
import type { GenerationOptions } from "@/lib/constants/generation";
import type {
  AgentBackendKind,
  CapabilityFixCapability,
  CapabilityFixPanel,
} from "@/lib/types/api";

export type { GenerationOptions };

/** One resolved agent tool step, streamed as an AI SDK UIMessage data part. */
export interface AgentRunStep {
  id: string;
  summary: string;
  toolName?: string;
}

/** A generated artifact (image) attached to a completed assistant turn. */
export interface AgentChatAsset {
  id: string;
  url: string;
}

export type AgentChatStatus = "running" | "complete" | "error";

export type AgentChatAction =
  | { type: "inpaint_layer"; layerId: string; prompt: string }
  | { type: "remove_background"; layerId: string };

export interface AgentChatError {
  code?: string;
  message: string;
}

export interface AgentChatBackendBadge {
  llm: string;
  image: string;
  generationBackend?: AgentBackendKind;
}

export interface AgentChatTaskControl {
  taskId: string;
  undoAvailable: boolean;
}

export interface AgentChatDataParts {
  [key: string]: unknown;
  "agent-status": { status: AgentChatStatus };
  "agent-step": AgentRunStep;
  "agent-asset": AgentChatAsset;
  "agent-capability-fix": {
    capability: CapabilityFixCapability;
    panel: CapabilityFixPanel;
    reason: string;
  };
  "agent-backend": AgentChatBackendBadge;
  "agent-error": AgentChatError;
  "agent-task": AgentChatTaskControl;
}

/**
 * AI SDK UIMessage with LuneryLab agent data parts. The wire/message format is
 * owned by the AI SDK and consumed by the assistant-ui AI SDK runtime adapter.
 */
export type AgentChatMessage = UIMessage<unknown, AgentChatDataParts>;

export function getAgentMessageText(message: AgentChatMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}
