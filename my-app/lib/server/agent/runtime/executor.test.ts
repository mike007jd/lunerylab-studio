import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((count: number) => ({ count })),
  buildCanvasSnapshot: vi.fn(),
  renderCanvasSnapshot: vi.fn(),
  resolveStudioRuntimeSupply: vi.fn(),
  resolveAgentLanguageModel: vi.fn(),
  buildAgentToolset: vi.fn(),
  getModelCatalog: vi.fn(),
  updateMany: vi.fn(),
  saveCanvasSnapshot: vi.fn(),
}));

vi.mock("ai", () => ({
  streamText: mocks.streamText,
  stepCountIs: mocks.stepCountIs,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/server/runtime-supply", () => ({
  resolveStudioRuntimeSupply: mocks.resolveStudioRuntimeSupply,
}));

vi.mock("@/lib/server/agent/runtime/resolve-language-model", () => ({
  resolveAgentLanguageModel: mocks.resolveAgentLanguageModel,
}));

vi.mock("@/lib/server/agent/runtime/canvas-serializer", () => ({
  buildCanvasSnapshot: mocks.buildCanvasSnapshot,
  renderCanvasSnapshot: mocks.renderCanvasSnapshot,
}));

vi.mock("@/lib/server/agent/runtime/system-prompt", () => ({
  buildAgentSystemPrompt: () => "system prompt",
}));

vi.mock("@/lib/server/agent/runtime/tool-registry", () => ({
  buildAgentToolset: mocks.buildAgentToolset,
}));

vi.mock("@/lib/server/model-catalog", () => ({
  getModelCatalog: mocks.getModelCatalog,
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    canvasSession: {
      updateMany: mocks.updateMany,
    },
  },
}));

vi.mock("@/lib/server/canvas-snapshot", () => ({
  saveCanvasSnapshot: mocks.saveCanvasSnapshot,
}));

import { runAgent } from "@/lib/server/agent/runtime/executor";
import type { AgentRunInput } from "@/lib/server/agent/runtime/types";

const baseInput: AgentRunInput = {
  userId: "user-1",
  sessionId: "session-1",
  message: "Create a new image.",
  selectedLayerId: null,
  uiContext: {
    selectedTextModelId: "",
    selectedModelId: "model-1",
    selectedAspectRatio: "1:1",
    selectedCount: 1,
    generationMode: "image",
  },
  locale: "en",
  maxSteps: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildCanvasSnapshot.mockResolvedValue({
    projectId: "project-1",
    selectedLayerId: null,
  });
  mocks.renderCanvasSnapshot.mockReturnValue("canvas snapshot");
  mocks.resolveStudioRuntimeSupply.mockResolvedValue({
    text: { backend: "local", warnings: [] },
    image: { backend: "byok", warnings: [] },
    backendUsed: { llm: "local", image: "fal" },
    generationBackend: "local",
    imageBackend: "byok",
    capabilityFix: undefined,
  });
  mocks.resolveAgentLanguageModel.mockResolvedValue({ model: { id: "local-model" } });
  mocks.getModelCatalog.mockResolvedValue({ imageModels: [], videoModels: [] });
  mocks.buildAgentToolset.mockReturnValue({});
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.saveCanvasSnapshot.mockResolvedValue(undefined);
});

describe("runAgent", () => {
  it("forwards only real model text deltas while the response is running", async () => {
    mocks.streamText.mockReturnValue({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Hello" };
        yield { type: "text-delta", text: " there" };
      })(),
      text: Promise.resolve("Hello there"),
    });
    const onTextDelta = vi.fn();

    const result = await runAgent({ ...baseInput, onTextDelta });

    expect(onTextDelta.mock.calls.flat()).toEqual(["Hello", " there"]);
    expect(result.assistantMessage).toBe("Hello there");
  });

  it("surfaces an error instead of synthesizing success when generateText returns no final text", async () => {
    mocks.streamText.mockReturnValue({
      fullStream: (async function* () {})(),
      text: Promise.resolve("   "),
    });

    const result = await runAgent(baseInput);

    expect(result.assistantMessage).toBe("The model did not return a final response. Please retry.");
    expect(result.error).toEqual({
      code: "agent_empty_final",
      message: "The model did not return a final response. Please retry.",
    });
    expect(result.stoppedByBudget).toBe(false);
  });

  it("fails deterministic actions when the expected tool execute handler is absent", async () => {
    mocks.buildAgentToolset.mockReturnValue({ remove_background: {} });

    const result = await runAgent({
      ...baseInput,
      action: { type: "remove_background", layerId: "layer-1" },
    });

    expect(mocks.streamText).not.toHaveBeenCalled();
    expect(result.assistantMessage).toBe('Agent tool "remove_background" is unavailable.');
    expect(result.error).toEqual({
      code: "agent_tool_unavailable",
      message: 'Agent tool "remove_background" is unavailable.',
    });
  });

  it("runs a deterministic action with no text LLM configured (image-only setup) (#2)", async () => {
    // Only image editing is available — no text backend at all.
    mocks.resolveStudioRuntimeSupply.mockResolvedValue({
      text: { backend: "none", warnings: [], fix: { capability: "text", panel: "provider_connections", reason: "no llm" } },
      image: { backend: "byok", warnings: [] },
      backendUsed: { llm: "none", image: "fal" },
      generationBackend: "none",
      imageBackend: "byok",
      capabilityFix: undefined,
    });
    const execute = vi.fn().mockResolvedValue({ ok: true, summary: "Removed background of layer layer-1." });
    mocks.buildAgentToolset.mockReturnValue({ remove_background: { execute } });

    const result = await runAgent({
      ...baseInput,
      action: { type: "remove_background", layerId: "layer-1" },
    });

    // The action ran without resolving a text model and without the "no backend" bail.
    expect(execute).toHaveBeenCalledWith({ layerId: "layer-1" });
    expect(mocks.resolveAgentLanguageModel).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.assistantMessage).toBe("Removed background of layer layer-1.");
  });

  it("returns a localized configuration block without treating missing models as a retryable error", async () => {
    mocks.resolveStudioRuntimeSupply.mockResolvedValue({
      text: {
        backend: "none",
        warnings: [],
        fix: { capability: "text", panel: "provider_connections", reason: "no llm" },
      },
      image: {
        backend: "none",
        warnings: [],
        fix: { capability: "image", panel: "local_models", reason: "no image" },
      },
      backendUsed: { llm: "none", image: "none" },
      generationBackend: "none",
      imageBackend: "none",
      capabilityFix: {
        capability: "text",
        panel: "provider_connections",
        reason: "no llm",
      },
    });

    const result = await runAgent({ ...baseInput, locale: "zh-CN" });

    expect(result.assistantMessage).toBe(
      "暂无可用的生成后端。请在设置中配置 Provider 或本地 Runtime。",
    );
    expect(result.capabilityFix?.capability).toBe("text");
    expect(result.error).toBeUndefined();
  });

  it("still tells the user to configure a text model for open-ended planning with no LLM", async () => {
    mocks.resolveStudioRuntimeSupply.mockResolvedValue({
      text: { backend: "none", warnings: [], fix: { capability: "text", panel: "provider_connections", reason: "no llm" } },
      image: { backend: "byok", warnings: [] },
      backendUsed: { llm: "none", image: "fal" },
      generationBackend: "none",
      imageBackend: "byok",
      capabilityFix: { panel: "provider_connections", reason: "no llm" },
    });

    const result = await runAgent(baseInput);

    expect(mocks.resolveAgentLanguageModel).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
    expect(result.assistantMessage).toContain("No text model is available");
    expect(result.error).toEqual({ message: "No text model is available to plan this request. Configure a text provider or local runtime in Settings." });
  });
});
