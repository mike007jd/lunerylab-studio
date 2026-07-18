"use client";

import { createContext, useContext, useState, type Dispatch, type SetStateAction } from "react";
import { AlertTriangle, Check, ImageOff, RefreshCw, RotateCcw } from "@/components/ui/icons";
import { AssetImage } from "@/components/ui/asset-image";
import { Button } from "@/components/ui/button";
import type { DataMessagePartComponent } from "@assistant-ui/react";
import { CapabilityMissingCard } from "@/components/canvas/capability-missing-card";
import { AgentCapabilityBadge } from "@/components/canvas/agent-capability-badge";
import { useT } from "@/lib/i18n/useT";
import { cn } from "@/lib/utils";
import type { GenerationOptions } from "@/lib/constants/generation";
import type { CapabilityFixCapability, CapabilityFixPanel } from "@/lib/types/api";
import type {
  AgentChatAsset,
  AgentChatError,
  AgentRunStep,
  AgentChatBackendBadge,
  AgentChatStatus,
} from "./agent-chat-types";

// ---------------------------------------------------------------------------
// AI SDK data part names after assistant-ui strips the `data-` prefix from the
// UIMessage stream chunk type.
// ---------------------------------------------------------------------------

export const AGENT_DATA_PART = {
  status: "agent-status",
  step: "agent-step",
  asset: "agent-asset",
  capabilityFix: "agent-capability-fix",
  backendBadge: "agent-backend",
  error: "agent-error",
  task: "agent-task",
} as const;

// ---------------------------------------------------------------------------
// UI context — lets deep part / composer components reach panel-level state
// (generation options, "focus this asset on the canvas") without prop drilling
// through assistant-ui primitives.
// ---------------------------------------------------------------------------

export interface AgentChatUI {
  options: GenerationOptions;
  setOptions: Dispatch<SetStateAction<GenerationOptions>>;
  showGenerationOptions: boolean;
  onFocusAsset?: (assetId: string) => void;
  /**
   * Whether a persisted chat asset still exists on the current Canvas. Chat
   * history outlives the layers it produced, so an asset action must resolve
   * against live Canvas state — an unresolvable asset is shown as unavailable
   * instead of rendering a clickable control that silently does nothing.
   */
  isAssetAvailable?: (assetId: string) => boolean;
  /** Re-send the last user message after a failed turn. */
  onRetry?: () => void;
}

const AgentChatUIContext = createContext<AgentChatUI | null>(null);

export const AgentChatUIProvider = AgentChatUIContext.Provider;

export function useAgentChatUI(): AgentChatUI {
  const ctx = useContext(AgentChatUIContext);
  if (!ctx) {
    throw new Error("useAgentChatUI must be used within AgentChatUIProvider");
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Part renderers
// ---------------------------------------------------------------------------

export const AgentThinkingPart: DataMessagePartComponent<{ status: AgentChatStatus }> = ({
  data,
}) => {
  const t = useT();
  if (data.status !== "running") return null;
  return (
    <span className="flex items-center gap-1 py-0.5" aria-label={t("agent.thinkingAria")}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground"
          style={{ animation: `chatDotBounce 1.2s ease-in-out ${i * 0.2}s infinite` }} // keep-dynamic: per-dot delay from index; keyframes in globals.css
        />
      ))}
    </span>
  );
};

export const AgentStepPart: DataMessagePartComponent<AgentRunStep> = ({ data }) => {
  const summary = data.summary;
  if (!summary) return null;
  return (
    <div className="flex items-start gap-1.5 py-0.5 text-xs text-muted-foreground">
      <Check className="mt-0.5 h-3 w-3 flex-none text-(--accent-primary)" />
      <span className="leading-snug">{summary}</span>
    </div>
  );
};

export const AgentAssetPart: DataMessagePartComponent<AgentChatAsset> = ({ data }) => {
  const t = useT();
  const { onFocusAsset, isAssetAvailable } = useAgentChatUI();
  if (!data.url) return null;
  // The asset action is only offered while the asset resolves against current
  // Canvas state; a stale asset keeps its thumbnail but shows why it is inert.
  const onCanvas = isAssetAvailable ? isAssetAvailable(data.id) : true;
  const focusable = Boolean(onFocusAsset && data.id && onCanvas);
  const stale = Boolean(onFocusAsset && data.id && !onCanvas);
  return (
    <Button
      type="button"
      disabled={!focusable}
      onClick={() => onFocusAsset?.(data.id)}
      variant="ghost"
      className={cn(
        "relative my-1.5 block h-auto aspect-4/3 w-full max-w-[260px] overflow-hidden rounded-xl border border-border bg-card p-0",
        focusable && "cursor-pointer transition-opacity hover:opacity-90",
        stale && "opacity-100 disabled:opacity-100",
      )}
    >
      <AssetImage
        src={data.url}
        alt={t("agent.designImageAlt")}
        className="absolute inset-0 h-full w-full object-cover"
      />
      {stale ? (
        <span
          data-slot="agent-asset-stale"
          className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-(--bg-base)/80 px-2 py-1.5 text-xs text-(--text-muted)"
        >
          <ImageOff className="h-3.5 w-3.5" />
          {t("agent.assetNotOnCanvas")}
        </span>
      ) : null}
    </Button>
  );
};

export const AgentErrorPart: DataMessagePartComponent<AgentChatError> = ({ data }) => {
  const t = useT();
  const { onRetry } = useAgentChatUI();
  if (!data.message) return null;
  return (
    <div className="my-1.5 flex flex-col gap-2 rounded-2xl rounded-tl-sm border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm">
      <p className="flex items-start gap-2 text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="leading-snug">{data.message}</span>
      </p>
      {onRetry ? (
        <div>
          <Button
            type="button"
            onClick={onRetry}
            variant="outline"
            size="xs"
            className="border-destructive/40 bg-(--bg-surface) text-destructive hover:bg-destructive/10"
          >
            <RefreshCw className="h-3 w-3" />
            {t("agent.retry")}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

export const AgentCapabilityFixPart: DataMessagePartComponent<{
  capability?: CapabilityFixCapability;
  panel?: CapabilityFixPanel;
  reason?: string;
}> = ({ data }) => {
  if (!data.panel) return null;
  return (
    <div className="my-1.5">
      <CapabilityMissingCard
        capabilityFix={{
          capability: data.capability ?? "text",
          panel: data.panel,
          reason: data.reason ?? "",
        }}
      />
    </div>
  );
};

export const AgentBackendBadgePart: DataMessagePartComponent<AgentChatBackendBadge> = ({
  data,
}) => {
  if (!data.llm || !data.image) return null;
  return (
    <AgentCapabilityBadge
      backendUsed={{ llm: data.llm, image: data.image }}
      generationBackend={data.generationBackend}
    />
  );
};

export const AgentTaskPart: DataMessagePartComponent<{ taskId: string; undoAvailable: boolean }> = ({ data }) => {
  const t = useT();
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState(false);
  if (!data.undoAvailable) return null;
  return (
    <Button
      type="button"
      size="xs"
      variant="ghostMuted"
      disabled={undoing || undone}
      onClick={() => {
        setUndoing(true);
        const sessionId = window.location.pathname.split("/").filter(Boolean).at(-1) ?? "";
        void fetch(`/api/canvas/sessions/${encodeURIComponent(sessionId)}/agent-tasks/${encodeURIComponent(data.taskId)}/undo`, { method: "POST" })
          .then((response) => {
            if (!response.ok) throw new Error("undo failed");
            setUndone(true);
            window.location.reload();
          })
          .finally(() => setUndoing(false));
      }}
    >
      <RotateCcw className="h-3 w-3" />
      {undone ? t("agent.undone") : undoing ? t("agent.undoing") : t("agent.undoTask")}
    </Button>
  );
};
