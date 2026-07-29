import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "@/lib/i18n/messages/en";

const readinessState = vi.hoisted(() => ({
  textStatus: "ready" as "ready" | "partial" | "missing",
}));

vi.mock("@assistant-ui/react", () => ({
  AuiIf: ({ children }: { children: ReactNode }) => <>{children}</>,
  ComposerPrimitive: {
    Root: ({ children, className }: { children: ReactNode; className?: string }) => (
      <form className={className}>{children}</form>
    ),
    Input: ({ submitOnEnter, ...props }: { submitOnEnter?: boolean } & Record<string, unknown>) => (
      <textarea data-submit-on-enter={String(submitOnEnter)} {...props} />
    ),
    Send: ({ children }: { children: ReactNode }) => <>{children}</>,
    Cancel: ({ children }: { children: ReactNode }) => <>{children}</>,
  },
  MessagePrimitive: {
    Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Parts: () => null,
  },
  ThreadPrimitive: {
    Root: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    Viewport: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    Messages: () => null,
  },
}));

vi.mock("@/components/studio/agent-chat/agent-message-parts", () => ({
  AGENT_DATA_PART: {
    status: "status",
    step: "step",
    asset: "asset",
    capabilityFix: "capabilityFix",
    backendBadge: "backendBadge",
    error: "error",
    task: "task",
  },
  AgentAssetPart: () => null,
  AgentBackendBadgePart: () => null,
  AgentCapabilityFixPart: () => null,
  AgentErrorPart: () => null,
  AgentStepPart: () => null,
  AgentThinkingPart: () => null,
  AgentTaskPart: () => null,
  useAgentChatUI: () => ({
    showGenerationOptions: false,
    options: { aspectRatio: "1:1", count: 1 },
    setOptions: () => {},
  }),
}));

vi.mock("@/hooks/use-creative-capability-readiness", () => ({
  useCreativeCapabilityReadiness: () => ({
    byId: {
      promptRefinement: {
        status: readinessState.textStatus,
        reason: "capabilityReadiness.prompt.missingReason",
        detail: "capabilityReadiness.prompt.missingDetail",
      },
    },
  }),
}));

import { AgentThread } from "@/components/studio/agent-chat/agent-thread";
import { I18nProvider } from "@/lib/i18n/provider";

function renderThread() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en" initialMessages={en}>
      <AgentThread />
    </I18nProvider>,
  );
}

describe("AgentThread text capability gating", () => {
  it("keeps Send enabled and Enter submission live when a text model is selected", () => {
    readinessState.textStatus = "ready";
    const markup = renderThread();

    expect(markup).toContain('data-submit-on-enter="true"');
    expect(markup).not.toContain(en.agent.openTextSettings);
    expect(markup).not.toContain(en.agent.textDraftHint);
  });

  it("preserves the draft, disables Send, and shows a Settings Text action when no text model is selected", () => {
    readinessState.textStatus = "partial";
    const markup = renderThread();

    // Draft stays editable (input not disabled), but Enter cannot submit.
    expect(markup).toContain('data-submit-on-enter="false"');
    expect(markup).not.toContain("<textarea disabled");
    // Send is disabled and the guidance + Settings Text action are visible.
    expect(markup).toContain('disabled=""');
    expect(markup).toContain(en.agent.textAiRequiredDetail);
    expect(markup).toContain(en.agent.openTextSettings);
    expect(markup).toContain("/settings?panel=text");
    expect(markup).toContain(en.agent.textDraftHint);
  });
});
