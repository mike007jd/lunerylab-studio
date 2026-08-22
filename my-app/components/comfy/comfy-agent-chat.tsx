"use client";

// Luna for Comfy — the ComfyUI workspace agent chat panel.
//
// Visual redesign vs the canvas chat: both sides get card containers, tool
// steps render inline above the assistant text, and the empty state offers
// suggestion chips. All styling rides the existing design tokens.

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Check, RotateCcw, Send, Square } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { LunaLogo } from "@/components/ui/luna-logo";
import { useT } from "@/lib/i18n/useT";
import {
  useComfyAgentChat,
  type ComfyAgentChatMessage,
} from "@/components/comfy/use-comfy-agent-chat";

function messageSteps(message: ComfyAgentChatMessage) {
  return message.parts
    .filter((part): part is { type: "data-agent-step"; data: { id: string; summary: string } } =>
      part.type === "data-agent-step",
    )
    .map((part) => part.data);
}

function messageError(message: ComfyAgentChatMessage): string | null {
  for (const part of message.parts) {
    if (part.type === "data-agent-error") {
      const data = part.data as { message?: unknown };
      if (typeof data?.message === "string" && data.message.trim()) return data.message;
    }
  }
  return null;
}

function messageText(message: ComfyAgentChatMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

export function ComfyAgentChat({ connectionId }: { connectionId: string | null }) {
  const t = useT();
  const { messages, status, stop, regenerate, sendMessage } = useComfyAgentChat({
    connectionId,
  });
  const [input, setInput] = useState("");
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const busy = status === "submitted" || status === "streaming";

  const submit = useCallback(() => {
    if (!input.trim() || busy) return;
    if (sendMessage(input)) setInput("");
  }, [input, busy, sendMessage]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        submit();
      }
    },
    [submit],
  );

  // Keep the newest message in view while streaming.
  const messagesLength = messages.length;
  const busyRef = busy;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messagesLength, busyRef]);

  const suggestions: Array<{ key: string; text: string }> = [
    { key: "chipObserve", text: t("comfy.agent.chipObserve") },
    { key: "chipEditPrompt", text: t("comfy.agent.chipEditPrompt") },
    { key: "chipRun", text: t("comfy.agent.chipRun") },
    { key: "chipModels", text: t("comfy.agent.chipModels") },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-(--border-subtle) bg-(--bg-surface)">
      <div className="flex items-center gap-2 border-b border-(--border-subtle) bg-(--bg-elevated) px-3.5 py-2.5">
        <span className="flex size-7 items-center justify-center rounded-full border border-(--border-subtle) bg-(--bg-base) text-(--accent)">
          <LunaLogo size={16} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-(--text-primary)">
            {t("comfy.agent.title")}
          </p>
          <p className="truncate text-xs text-(--text-muted)">{t("comfy.agent.subtitle")}</p>
        </div>
        {busy ? (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-(--text-secondary)">
            <Activity className="size-3.5 animate-pulse text-(--accent)" />
            {t("comfy.agent.thinking")}
          </span>
        ) : (
          <span
            className="ml-auto size-2 rounded-full bg-(--success)"
            aria-label={t("comfy.agent.ready")}
            title={t("comfy.agent.ready")}
          />
        )}
      </div>

      <div ref={viewportRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
            <span className="flex size-10 items-center justify-center rounded-full border border-(--border-subtle) bg-(--bg-base) text-(--accent)">
              <LunaLogo size={22} />
            </span>
            <div>
              <p className="text-sm font-semibold text-(--text-primary)">
                {t("comfy.agent.welcome")}
              </p>
              <p className="mt-1 text-xs text-(--text-secondary)">
                {t("comfy.agent.welcomeHint")}
              </p>
            </div>
            <div className="grid w-full max-w-sm grid-cols-1 gap-2 sm:grid-cols-2">
              {suggestions.map((suggestion) => (
                <Button
                  key={suggestion.key}
                  variant="outline"
                  size="tool"
                  className="h-auto whitespace-normal py-2 text-left"
                  onClick={() => sendMessage(suggestion.text)}
                >
                  {suggestion.text}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => {
            if (message.role === "user") {
              return (
                <div key={message.id} className="flex justify-end pl-8">
                  <div className="rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                    <p className="whitespace-pre-wrap break-words">{messageText(message)}</p>
                  </div>
                </div>
              );
            }
            const steps = messageSteps(message);
            const errorText = messageError(message);
            const text = messageText(message);
            return (
              <div key={message.id} className="flex justify-start pr-8">
                <div className="flex min-w-0 flex-col gap-2">
                  {steps.length > 0 ? (
                    <div className="flex flex-col gap-1 pl-1">
                      {steps.map((step) => (
                        <span
                          key={step.id}
                          className="flex items-center gap-1.5 text-xs text-(--text-muted)"
                        >
                          <Check className="size-3 text-(--success)" />
                          {step.summary}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {errorText ? (
                    <div className="rounded-2xl rounded-tl-sm border border-destructive/30 bg-destructive/5 px-3.5 py-2.5">
                      <p className="whitespace-pre-wrap break-words text-sm text-destructive">
                        {errorText}
                      </p>
                      <Button
                        size="xs"
                        variant="outline"
                        className="mt-2"
                        onClick={() => regenerate()}
                      >
                        <RotateCcw />
                        {t("comfy.agent.retry")}
                      </Button>
                    </div>
                  ) : text ? (
                    <div className="rounded-2xl rounded-tl-sm border border-(--border-subtle) bg-(--bg-elevated) px-3.5 py-2.5">
                      <p className="whitespace-pre-wrap break-words text-sm text-(--text-primary)">
                        {text}
                      </p>
                    </div>
                  ) : busy ? (
                    <div className="rounded-2xl rounded-tl-sm border border-(--border-subtle) bg-(--bg-elevated) px-3.5 py-2.5">
                      <p className="text-sm text-(--text-muted)">{t("comfy.agent.thinking")}</p>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-(--border-subtle) bg-(--bg-elevated) p-2.5">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("comfy.agent.placeholder")}
          aria-label={t("comfy.agent.placeholder")}
          className="h-9 min-w-0 flex-1 rounded-xl border border-(--border-subtle) bg-(--bg-base) px-3 text-sm text-(--text-primary) placeholder:text-(--text-muted)"
        />
        {busy ? (
          <Button size="sm" variant="outline" onClick={() => stop()} aria-label={t("comfy.agent.stop")}>
            <Square />
            {t("comfy.agent.stop")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="accent"
            onClick={submit}
            disabled={!input.trim()}
            aria-label={t("comfy.agent.send")}
          >
            <Send />
            {t("comfy.agent.send")}
          </Button>
        )}
      </div>
    </div>
  );
}
