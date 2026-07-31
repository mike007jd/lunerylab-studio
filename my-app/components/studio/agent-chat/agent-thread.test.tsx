import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/lib/i18n/messages/en";
import type { AgentModelRouting } from "@/components/studio/agent-chat/agent-message-parts";

const readinessState = vi.hoisted(() => ({
  textStatus: "ready" as "ready" | "partial" | "missing",
}));

const routingState = vi.hoisted(() => ({
  modelRouting: undefined as AgentModelRouting | undefined,
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

// Popover/Select portal their content only when open; for static markup tests
// render everything inline so the routing controls are assertable.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ value, children }: { value?: string; children: ReactNode }) => (
    <div data-select-value={value ?? ""}>{children}</div>
  ),
  SelectTrigger: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button type="button" {...props}>{children}</button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <div data-value={value}>{children}</div>
  ),
}));

vi.mock("@/components/studio/agent-chat/agent-message-parts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/components/studio/agent-chat/agent-message-parts")
  >();
  return {
    ...actual,
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
      modelRouting: routingState.modelRouting,
    }),
  };
});

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
import {
  AGENT_MODEL_ROUTING_AUTO,
  resolveAgentImageModelId,
  resolveAgentTextModelId,
} from "@/components/studio/agent-chat/agent-message-parts";
import {
  buildAgentImageModelOptions,
  buildAgentTextModelOptions,
  buildUiContext,
} from "@/components/studio/agent-chat/use-agent-chat";
import type { ImageModelEntry } from "@/lib/image-models";
import { I18nProvider } from "@/lib/i18n/provider";

function renderThread() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en" initialMessages={en}>
      <AgentThread />
    </I18nProvider>,
  );
}

beforeEach(() => {
  readinessState.textStatus = "ready";
  routingState.modelRouting = undefined;
});

describe("AgentThread text capability gating", () => {
  it("keeps Send enabled and Enter submission live when a text model is selected", () => {
    const markup = renderThread();

    expect(markup).toContain('data-submit-on-enter="true"');
    expect(markup).not.toContain(en.agent.openTextSettings);
    expect(markup).not.toContain(en.agent.textDraftHint);
  });

  it("preserves the draft, disables Send, and shows a Settings CTA action when no text model is selected", () => {
    readinessState.textStatus = "partial";
    const markup = renderThread();

    // Draft stays editable (input not disabled), but Enter cannot submit.
    expect(markup).toContain('data-submit-on-enter="false"');
    expect(markup).not.toContain("<textarea disabled");
    // Send is disabled and the guidance + Settings CTA action are visible.
    expect(markup).toContain('disabled=""');
    expect(markup).toContain(en.agent.textAiRequiredDetail);
    expect(markup).toContain(en.agent.openTextSettings);
    expect(markup).toContain("/settings?panel=text");
    expect(markup).toContain(en.agent.textDraftHint);
  });
});

describe("AgentThread model routing", () => {
  it("hides the Models control when no routing state is provided", () => {
    const markup = renderThread();

    expect(markup).not.toContain('data-routing-trigger="models"');
  });

  it("shows the resolved bootstrap defaults in Auto mode without manual selectors", () => {
    routingState.modelRouting = {
      textSelection: AGENT_MODEL_ROUTING_AUTO,
      imageSelection: AGENT_MODEL_ROUTING_AUTO,
      textModelId: "local:qwen3",
      imageModelId: "fal:flux",
      onTextSelectionChange: () => {},
      onImageSelectionChange: () => {},
      textOptions: [{ id: "local:qwen3", label: "Local — qwen3" }],
      imageOptions: [{ id: "fal:flux", label: "Fal — Flux" }],
      autoTextModelId: "local:qwen3",
      autoImageModelId: "fal:flux",
    };
    const markup = renderThread();

    expect(markup).toContain('data-routing-trigger="models"');
    expect(markup).toContain(en.agent.modelsAuto);
    expect(markup).toContain(en.agent.modelsManual);
    expect(markup).toContain("Local — qwen3");
    expect(markup).toContain("Fal — Flux");
    expect(markup).not.toContain('data-routing-select="text"');
    expect(markup).not.toContain('data-routing-select="image"');
  });

  it("exposes separate Chat and Image selectors in Manual mode populated from the provided entries", () => {
    routingState.modelRouting = {
      textSelection: "byok:openai:gpt-5",
      imageSelection: "fal:flux",
      textModelId: "byok:openai:gpt-5",
      imageModelId: "fal:flux",
      onTextSelectionChange: () => {},
      onImageSelectionChange: () => {},
      textOptions: [
        { id: "local:qwen3", label: "Local — qwen3" },
        { id: "byok:openai:gpt-5", label: "openai — gpt-5" },
      ],
      imageOptions: [
        { id: "fal:flux", label: "Fal — Flux" },
        { id: "fal:sdxl", label: "Fal — SDXL" },
      ],
      autoTextModelId: "local:qwen3",
      autoImageModelId: "fal:flux",
    };
    const markup = renderThread();

    expect(markup).toContain('data-routing-select="text"');
    expect(markup).toContain('data-routing-select="image"');
    expect(markup).toContain('data-select-value="byok:openai:gpt-5"');
    expect(markup).toContain('data-select-value="fal:flux"');
    expect(markup).toContain('data-value="local:qwen3"');
    expect(markup).toContain('data-value="byok:openai:gpt-5"');
    expect(markup).toContain('data-value="fal:sdxl"');
    expect(markup).toContain(en.agent.chatModel);
    expect(markup).toContain(en.agent.imageModel);
  });

  it("uses a valid Manual chat model for sending even when the persisted default is not ready", () => {
    readinessState.textStatus = "partial";
    routingState.modelRouting = {
      textSelection: "byok:openai:gpt-5",
      imageSelection: "fal:flux",
      textModelId: "byok:openai:gpt-5",
      imageModelId: "fal:flux",
      onTextSelectionChange: () => {},
      onImageSelectionChange: () => {},
      textOptions: [{ id: "byok:openai:gpt-5", label: "OpenAI · gpt-5" }],
      imageOptions: [{ id: "fal:flux", label: "Fal · Flux" }],
      autoTextModelId: "local:stale",
      autoImageModelId: "fal:flux",
    };
    const markup = renderThread();

    expect(markup).toContain('data-submit-on-enter="true"');
    expect(markup).not.toContain(en.agent.textDraftHint);
  });

  it("keeps sending disabled when Manual mode has no effective chat model", () => {
    routingState.modelRouting = {
      textSelection: "",
      imageSelection: AGENT_MODEL_ROUTING_AUTO,
      textModelId: "",
      imageModelId: "fal:flux",
      onTextSelectionChange: () => {},
      onImageSelectionChange: () => {},
      textOptions: [],
      imageOptions: [{ id: "fal:flux", label: "Fal · Flux" }],
      autoTextModelId: "local:stale",
      autoImageModelId: "fal:flux",
    };
    const markup = renderThread();

    expect(markup).toContain('data-submit-on-enter="false"');
    expect(markup).toContain(en.agent.textDraftHint);
  });

  it("surfaces the missing image model state in Manual mode", () => {
    routingState.modelRouting = {
      textSelection: "byok:openai:gpt-5",
      imageSelection: "",
      textModelId: "byok:openai:gpt-5",
      imageModelId: "",
      onTextSelectionChange: () => {},
      onImageSelectionChange: () => {},
      textOptions: [{ id: "byok:openai:gpt-5", label: "OpenAI · gpt-5" }],
      imageOptions: [{ id: "fal:flux", label: "Fal · Flux" }],
      autoTextModelId: "local:qwen3",
      autoImageModelId: "fal:flux",
    };
    const markup = renderThread();

    expect(markup).toContain('data-routing-image-missing="true"');
    expect(markup).toContain(en.agent.imageModelNotSet);
    // Chat stays usable — only the image slot is missing.
    expect(markup).toContain('data-submit-on-enter="true"');
  });

  it("surfaces the missing image model state in Auto mode when no default is persisted", () => {
    routingState.modelRouting = {
      textSelection: AGENT_MODEL_ROUTING_AUTO,
      imageSelection: AGENT_MODEL_ROUTING_AUTO,
      textModelId: "local:qwen3",
      imageModelId: "",
      onTextSelectionChange: () => {},
      onImageSelectionChange: () => {},
      textOptions: [{ id: "local:qwen3", label: "Local AI · qwen3" }],
      imageOptions: [],
      autoTextModelId: "local:qwen3",
      autoImageModelId: "",
    };
    const markup = renderThread();

    expect(markup).toContain('data-routing-image-missing="true"');
    expect(markup).toContain(en.agent.imageModelNotSet);
    expect(markup).toContain(en.agent.modelNone);
  });
});

describe("agent model routing resolvers", () => {
  it("resolves Auto text from the bootstrap default and Manual text only from live options", () => {
    const options = [
      { id: "local:qwen3", label: "Local AI · qwen3" },
      { id: "byok:openai:gpt-5", label: "OpenAI · gpt-5" },
    ];

    // Auto passes the persisted default verbatim, even when it is not a live option.
    expect(resolveAgentTextModelId(AGENT_MODEL_ROUTING_AUTO, "local:gone", options)).toBe("local:gone");
    expect(resolveAgentTextModelId("byok:openai:gpt-5", "local:qwen3", options)).toBe(
      "byok:openai:gpt-5",
    );
    expect(resolveAgentTextModelId("byok:openai:removed", "local:qwen3", options)).toBe("");
    expect(resolveAgentTextModelId("", "local:qwen3", options)).toBe("");
  });

  it("resolves Auto image routing only from the bootstrap default, never a first-catalog fallback", () => {
    const catalog = [{ id: "fal:flux" }, { id: "fal:sdxl" }];

    expect(resolveAgentImageModelId(AGENT_MODEL_ROUTING_AUTO, "fal:sdxl", catalog)).toBe("fal:sdxl");
    // No bootstrap default → empty, even though the catalog has entries.
    expect(resolveAgentImageModelId(AGENT_MODEL_ROUTING_AUTO, "", catalog)).toBe("");
    // A default that is no longer in the live catalog resolves to empty.
    expect(resolveAgentImageModelId(AGENT_MODEL_ROUTING_AUTO, "fal:gone", catalog)).toBe("");
    // Manual override is validated against the live catalog as well.
    expect(resolveAgentImageModelId("fal:flux", "fal:sdxl", catalog)).toBe("fal:flux");
    expect(resolveAgentImageModelId("fal:gone", "fal:sdxl", catalog)).toBe("");
    // A null catalog (still loading) trusts the requested id until it lands.
    expect(resolveAgentImageModelId(AGENT_MODEL_ROUTING_AUTO, "fal:sdxl", null)).toBe("fal:sdxl");
  });
});

describe("agent routing option builders", () => {
  it("builds text options only from the current local model and configured BYOK text slots", () => {
    const options = buildAgentTextModelOptions({
      providerConnections: {
        openai: { models: { text: "gpt-5" } },
        anthropic: { models: { text: "claude-sonnet-4-6" } },
        gemini: { models: { text: "gemini-3" } },
      },
      providers: {
        openai: { configured: true },
        anthropic: { configured: false },
        gemini: { configured: false },
      },
      localTextModelId: "qwen3",
      localTextModelLabel: "Qwen 3",
      localSourceLabel: "Local AI",
    });

    expect(options).toEqual([
      { id: "local:qwen3", label: "Local AI · Qwen 3" },
      { id: "byok:openai:gpt-5", label: "OpenAI · gpt-5" },
    ]);
  });

  it("omits the local text option when no local text model is loaded", () => {
    const options = buildAgentTextModelOptions({
      providerConnections: {},
      providers: {},
      localTextModelId: null,
      localTextModelLabel: null,
      localSourceLabel: "Local AI",
    });

    expect(options).toEqual([]);
  });

  it("omits BYOK text slots that have no model id even when the provider is configured", () => {
    const options = buildAgentTextModelOptions({
      providerConnections: {
        openai: { models: { text: "gpt-5" } },
        anthropic: { models: {} },
      },
      providers: {
        openai: { configured: true },
        anthropic: { configured: true },
      },
      localTextModelId: null,
      localTextModelLabel: null,
      localSourceLabel: "Local AI",
    });

    expect(options).toEqual([{ id: "byok:openai:gpt-5", label: "OpenAI · gpt-5" }]);
  });

  it("builds image options from the live catalog with locale-aware labels", () => {
    const models = [
      { id: "fal:flux", label: "Flux Pro", labelZh: "Flux 专业版" },
      { id: "local:sdxl", label: "SDXL", labelZh: "SDXL 中文" },
    ] as unknown as ImageModelEntry[];

    expect(buildAgentImageModelOptions(models, false)).toEqual([
      { id: "fal:flux", label: "Flux Pro" },
      { id: "local:sdxl", label: "SDXL" },
    ]);
    expect(buildAgentImageModelOptions(models, true)).toEqual([
      { id: "fal:flux", label: "Flux 专业版" },
      { id: "local:sdxl", label: "SDXL 中文" },
    ]);
  });
});

describe("agent uiContext transport payload", () => {
  it("passes the routed text/image ids through unchanged", () => {
    const uiContext = buildUiContext(
      { aspectRatio: "16:9", count: 2 },
      "byok:fal:flux-pro",
      "byok:openai:gpt-5",
      "image",
    );

    expect(uiContext).toEqual({
      selectedTextModelId: "byok:openai:gpt-5",
      selectedModelId: "byok:fal:flux-pro",
      selectedAspectRatio: "16:9",
      selectedCount: 2,
      generationMode: "image",
    });
  });

  it("keeps empty ids empty — no fallback is invented at the transport boundary", () => {
    const uiContext = buildUiContext({ aspectRatio: "auto", count: 1 }, "", "", "image");

    expect(uiContext.selectedTextModelId).toBe("");
    expect(uiContext.selectedModelId).toBe("");
  });
});
