"use client";

import type { FC } from "react";
import Link from "next/link";
import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { Cpu, Send, Settings } from "@/components/ui/icons";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { Button } from "@/components/ui/button";
import { LunaLogo } from "@/components/ui/luna-logo";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/useT";
import { useCreativeCapabilityReadiness } from "@/hooks/use-creative-capability-readiness";
import { ASPECT_RATIOS, COUNT_OPTIONS, type AspectRatioValue, type CountValue } from "@/lib/constants/generation";
import { formatGenerationOptionsSummary } from "@/lib/client/generation-presentation";
import {
  AGENT_DATA_PART,
  AGENT_MODEL_ROUTING_AUTO,
  AgentAssetPart,
  AgentBackendBadgePart,
  AgentCapabilityFixPart,
  AgentErrorPart,
  AgentStepPart,
  AgentThinkingPart,
  AgentTaskPart,
  useAgentChatUI,
  type AgentModelRoutingOption,
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
          className="h-7 max-w-full gap-1.5"
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

function routingLabel(options: AgentModelRoutingOption[], id: string, fallback: string): string {
  if (!id) return fallback;
  return options.find((option) => option.id === id)?.label ?? id;
}

function ModelRoutingSelect({
  label,
  selectName,
  value,
  options,
  onChange,
}: {
  label: string;
  selectName: "text" | "image";
  value: string;
  options: AgentModelRoutingOption[];
  onChange: (next: string) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {options.length > 0 ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger
            size="sm"
            className="w-full"
            data-routing-select={selectName}
            aria-label={label}
          >
            <SelectValue placeholder={t("agent.selectModel")} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("agent.noConfiguredModels")}
        </p>
      )}
    </div>
  );
}

function ModelRoutingBar() {
  const t = useT();
  const { modelRouting } = useAgentChatUI();
  if (!modelRouting) return null;
  const {
    textSelection,
    imageSelection,
    imageModelId,
    onTextSelectionChange,
    onImageSelectionChange,
    textOptions,
    imageOptions,
    autoTextModelId,
    autoImageModelId,
  } = modelRouting;
  const isAuto =
    textSelection === AGENT_MODEL_ROUTING_AUTO &&
    imageSelection === AGENT_MODEL_ROUTING_AUTO;
  const mode = isAuto ? "auto" : "manual";
  // Surfaced on the trigger + inside the popover so a missing image model is
  // visible before the user sends — the runtime also reports it, but the
  // control should never look ready when no image model will resolve.
  const imageMissing = !imageModelId;
  const handleModeChange = (next: string) => {
    if (next === "auto") {
      onTextSelectionChange(AGENT_MODEL_ROUTING_AUTO);
      onImageSelectionChange(AGENT_MODEL_ROUTING_AUTO);
    } else if (next === "manual") {
      // Entering Manual pins the currently-effective ids so nothing changes
      // under the user until they pick a different model — but only ids that
      // are still live options; a stale default stays "no model selected".
      if (textSelection === AGENT_MODEL_ROUTING_AUTO) {
        onTextSelectionChange(
          textOptions.some((option) => option.id === autoTextModelId) ? autoTextModelId : "",
        );
      }
      if (imageSelection === AGENT_MODEL_ROUTING_AUTO) {
        onImageSelectionChange(
          imageOptions.some((option) => option.id === autoImageModelId) ? autoImageModelId : "",
        );
      }
    }
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghostMuted"
          size="xs"
          className="h-7 max-w-full gap-1.5"
          data-routing-trigger="models"
          aria-label={`${t("agent.models")}: ${isAuto ? t("agent.modelsAuto") : t("agent.modelsManual")}`}
        >
          <Cpu className="h-3.5 w-3.5" />
          <span>{isAuto ? t("agent.modelsAuto") : t("agent.modelsManual")}</span>
          {imageMissing ? (
            <span
              className="h-1.5 w-1.5 flex-none rounded-full bg-(--warning)"
              aria-hidden="true"
              data-routing-image-missing="true"
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 max-w-full space-y-3 p-3"
      >
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={handleModeChange}
          size="sm"
          className="justify-start gap-1"
          aria-label={t("agent.models")}
        >
          <ToggleGroupItem
            value="auto"
            className="h-7 px-2 text-xs data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
          >
            {t("agent.modelsAuto")}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="manual"
            className="h-7 px-2 text-xs data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
          >
            {t("agent.modelsManual")}
          </ToggleGroupItem>
        </ToggleGroup>
        {isAuto ? (
          <dl className="space-y-1.5 text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <dt className="flex-none font-medium text-muted-foreground">{t("agent.chatModel")}</dt>
              <dd className="min-w-0 truncate text-foreground">
                {routingLabel(textOptions, autoTextModelId, t("agent.modelNone"))}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="flex-none font-medium text-muted-foreground">{t("agent.imageModel")}</dt>
              <dd className="min-w-0 truncate text-foreground">
                {routingLabel(imageOptions, autoImageModelId, t("agent.modelNone"))}
              </dd>
            </div>
          </dl>
        ) : (
          <>
            <ModelRoutingSelect
              label={t("agent.chatModel")}
              selectName="text"
              value={textSelection === AGENT_MODEL_ROUTING_AUTO ? "" : textSelection}
              options={textOptions}
              onChange={onTextSelectionChange}
            />
            <ModelRoutingSelect
              label={t("agent.imageModel")}
              selectName="image"
              value={imageSelection === AGENT_MODEL_ROUTING_AUTO ? "" : imageSelection}
              options={imageOptions}
              onChange={onImageSelectionChange}
            />
          </>
        )}
        {imageMissing ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("agent.imageModelNotSet")}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

const Composer: FC = () => {
  const t = useT();
  const { showGenerationOptions, modelRouting } = useAgentChatUI();
  // Shared text capability readiness gates the assistant: with no selected
  // text model the draft stays editable, Send is disabled, Enter cannot
  // submit, and visible setup guidance with a Settings Text action shows
  // before any generation boundary.
  const readiness = useCreativeCapabilityReadiness();
  const textCapability = readiness.byId.promptRefinement;
  const textUsesAuto = !modelRouting || modelRouting.textSelection === AGENT_MODEL_ROUTING_AUTO;
  const textReady = textUsesAuto
    ? textCapability.status === "ready" && (!modelRouting || Boolean(modelRouting.textModelId))
    : Boolean(modelRouting.textModelId);
  return (
    <ComposerPrimitive.Root className="flex-none border-t border-border bg-popover px-3 py-3">
      {showGenerationOptions || modelRouting ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {showGenerationOptions ? <GenerationOptionsBar /> : null}
          <ModelRoutingBar />
        </div>
      ) : null}
      {!textReady ? (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-(--warning-soft) bg-(--warning-soft) px-3 py-2">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-(--text-secondary)">
            {t("agent.textAiRequiredDetail")}
          </p>
          <Button asChild type="button" size="xs" variant="outline" className="shrink-0">
            <Link href="/settings?panel=text">{t("agent.openTextSettings")}</Link>
          </Button>
        </div>
      ) : null}
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2">
        <ComposerPrimitive.Input
          rows={1}
          autoFocus
          placeholder={t("agent.continuePlaceholder")}
          submitOnEnter={textReady}
          className="max-h-[120px] min-h-6 flex-1 resize-none overflow-y-auto bg-transparent p-0 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70"
        />
        <div className="flex flex-none items-center">
          <AuiIf condition={(s) => !s.thread.isRunning}>
            {textReady ? (
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
            ) : (
              <Button
                type="button"
                disabled
                aria-label={t("agent.sendMessage")}
                variant="accent"
                size="icon-chat"
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            )}
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
        {textReady ? t("agent.sendHint") : t("agent.textDraftHint")}
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
