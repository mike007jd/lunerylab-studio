"use client";

import type { FC } from "react";
import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { Send, Settings } from "@/components/ui/icons";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { Button } from "@/components/ui/button";
import { LunaLogo } from "@/components/ui/luna-logo";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/lib/i18n/useT";
import { ASPECT_RATIOS, COUNT_OPTIONS, type AspectRatioValue, type CountValue } from "@/lib/constants/generation";
import { formatGenerationOptionsSummary } from "@/lib/client/generation-presentation";
import {
  AGENT_DATA_PART,
  AgentAssetPart,
  AgentBackendBadgePart,
  AgentCapabilityFixPart,
  AgentErrorPart,
  AgentStepPart,
  AgentThinkingPart,
  AgentTaskPart,
  useAgentChatUI,
} from "./agent-message-parts";

// Single source of truth for how each message part type renders. AI SDK
// `data-agent-*` chunks arrive as assistant-ui data parts; plain text uses the
// markdown renderer.
const PARTS_COMPONENTS = {
  Text: MarkdownText,
  data: {
    by_name: {
      [AGENT_DATA_PART.status]: AgentThinkingPart,
      [AGENT_DATA_PART.step]: AgentStepPart,
      [AGENT_DATA_PART.asset]: AgentAssetPart,
      [AGENT_DATA_PART.capabilityFix]: AgentCapabilityFixPart,
      [AGENT_DATA_PART.backendBadge]: AgentBackendBadgePart,
      [AGENT_DATA_PART.error]: AgentErrorPart,
      [AGENT_DATA_PART.task]: AgentTaskPart,
    },
  },
} as const;

function LunaAvatar() {
  return (
    <span
      className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-border bg-card text-primary"
      aria-hidden="true"
    >
      <LunaLogo size={18} />
    </span>
  );
}

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="flex justify-end" data-role="user">
      <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="flex items-start gap-2" data-role="assistant">
      <LunaAvatar />
      <div className="min-w-0 flex-1 space-y-0.5 pt-0.5 text-sm leading-relaxed text-foreground">
        <MessagePrimitive.Parts components={PARTS_COMPONENTS} />
      </div>
    </MessagePrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  return (
    <>
      <AuiIf condition={(s) => s.message.role === "user"}>
        <UserMessage />
      </AuiIf>
      <AuiIf condition={(s) => s.message.role !== "user"}>
        <AssistantMessage />
      </AuiIf>
    </>
  );
};

const ThreadWelcome: FC = () => {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 pt-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card text-primary">
        <LunaLogo size={30} />
      </span>
      <p className="text-sm text-muted-foreground">{t("agent.greeting")}</p>
    </div>
  );
};

function GenerationOptionsBar() {
  const t = useT();
  const { options, setOptions } = useAgentChatUI();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghostMuted"
          size="xs"
          className="mb-2 h-7 max-w-full gap-1.5"
          aria-label={`${t("agent.ratio")}, ${t("agent.count")}: ${formatGenerationOptionsSummary(options.aspectRatio, options.count)}`}
        >
          <Settings className="h-3.5 w-3.5" />
          <span>{formatGenerationOptionsSummary(options.aspectRatio, options.count)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[min(320px,calc(100vw-32px))] space-y-3 p-3"
      >
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t("agent.ratio")}</span>
          <ToggleGroup
            type="single"
            value={options.aspectRatio}
            onValueChange={(value) => {
              if (value) setOptions((prev) => ({ ...prev, aspectRatio: value as AspectRatioValue }));
            }}
            size="sm"
            className="flex-wrap justify-start gap-1"
          >
            {ASPECT_RATIOS.map((ar) => (
              <ToggleGroupItem
                key={ar.value}
                value={ar.value}
                className="h-7 px-2 text-xs data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
              >
                {ar.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t("agent.count")}</span>
          <ToggleGroup
            type="single"
            value={String(options.count)}
            onValueChange={(value) => {
              const next = Number(value) as CountValue;
              if (COUNT_OPTIONS.includes(next)) {
                setOptions((prev) => ({ ...prev, count: next }));
              }
            }}
            size="sm"
            className="justify-start gap-1"
          >
            {COUNT_OPTIONS.map((count) => (
              <ToggleGroupItem
                key={count}
                value={String(count)}
                className="h-7 min-w-8 px-2 text-xs data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
              >
                {count}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const Composer: FC = () => {
  const t = useT();
  const { showGenerationOptions } = useAgentChatUI();
  return (
    <ComposerPrimitive.Root className="flex-none border-t border-border bg-popover px-3 py-3">
      {showGenerationOptions ? <GenerationOptionsBar /> : null}
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2">
        <ComposerPrimitive.Input
          rows={1}
          autoFocus
          placeholder={t("agent.continuePlaceholder")}
          className="max-h-[120px] min-h-6 flex-1 resize-none overflow-y-auto bg-transparent p-0 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70"
        />
        <div className="flex flex-none items-center">
          <AuiIf condition={(s) => !s.thread.isRunning}>
            <ComposerPrimitive.Send asChild>
              <Button
                type="button"
                aria-label={t("agent.sendMessage")}
                variant="accent"
                size="icon-chat"
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            </ComposerPrimitive.Send>
          </AuiIf>
          <AuiIf condition={(s) => s.thread.isRunning}>
            <ComposerPrimitive.Cancel asChild>
              <Button
                type="button"
                aria-label={t("agent.stop")}
                variant="destructive"
                size="icon-chat"
              >
                <span className="block h-3.5 w-3.5 rounded-sm bg-current" aria-hidden />
              </Button>
            </ComposerPrimitive.Cancel>
          </AuiIf>
        </div>
      </div>
      <p className="mt-1.5 text-center text-xs text-muted-foreground">
        {t("agent.sendHint")}
      </p>
    </ComposerPrimitive.Root>
  );
};

/**
 * Compact agent chat thread tuned for the canvas floating dock. Composes
 * assistant-ui primitives directly (rather than the page-scale generated
 * `<Thread/>`) so we control sizing, branding, the generation-options bar, and
 * i18n. Must be rendered inside an `AssistantRuntimeProvider` +
 * `AgentChatUIProvider` (see agent-chat-panel.tsx).
 */
export function AgentThread() {
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col bg-background">
      <ThreadPrimitive.Viewport className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <ThreadWelcome />
        </AuiIf>
        <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      <Composer />
    </ThreadPrimitive.Root>
  );
}
