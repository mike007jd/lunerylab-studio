import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  runAgent: vi.fn(),
  createAgentTask: vi.fn(),
  persistAgentTaskStep: vi.fn(),
  finishAgentTask: vi.fn(),
  failAgentTask: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));

vi.mock("@/lib/server/agent/runtime/run", () => ({
  runAgent: mocks.runAgent,
}));

vi.mock("@/lib/server/agent/task-store", () => ({
  createAgentTask: mocks.createAgentTask,
  persistAgentTaskStep: mocks.persistAgentTaskStep,
  finishAgentTask: mocks.finishAgentTask,
  failAgentTask: mocks.failAgentTask,
}));

import { POST } from "@/app/api/chat/route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify(body),
  });
}

async function readResponse(response: Response): Promise<string> {
  return await response.text();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
  mocks.createAgentTask.mockResolvedValue({ id: "task-1", createdAt: new Date() });
  mocks.persistAgentTaskStep.mockResolvedValue(undefined);
  mocks.finishAgentTask.mockResolvedValue(undefined);
  mocks.failAgentTask.mockResolvedValue(undefined);
});

describe("/api/chat UIMessage stream", () => {
  it("streams live model text and persists the completed assistant turn", async () => {
    mocks.runAgent.mockImplementation(async (input) => {
      input.onTextDelta?.("Working");
      input.onTextDelta?.(" now");
      return {
        runId: "run-1",
        assistantMessage: "Working now",
        steps: [],
        artifacts: {},
        backendUsed: { llm: "local", image: "none" },
        generationBackend: "local",
        imageBackend: "none",
        durationMs: 12,
        stoppedByBudget: false,
      };
    });

    const response = await POST(request({ sessionId: "session-1", message: "Hello" }));
    const text = await readResponse(response);

    expect(text).toContain('"type":"text-delta","id":"agent-final","delta":"Working"');
    expect(text).toContain('"type":"text-delta","id":"agent-final","delta":" now"');
    expect(mocks.finishAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", cancelled: false }),
    );
  });

  it("streams AI SDK UIMessage data parts and forwards deterministic actions", async () => {
    mocks.runAgent.mockImplementation(async (input) => {
      input.onStep?.({
        id: "step-1",
        summary: "Removed background of layer layer-1.",
        toolName: "remove_background",
      });
      return {
        runId: "run-1",
        assistantMessage: "Background removed.",
        steps: [],
        artifacts: { generatedAssetIds: ["asset-1"] },
        backendUsed: { llm: "local", image: "fal" },
        generationBackend: "byok",
        imageBackend: "byok",
        durationMs: 12,
        stoppedByBudget: false,
      };
    });

    const response = await POST(
      request({
        sessionId: "session-1",
        messages: [
          {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text: "Remove the background." }],
          },
        ],
        selectedLayerId: "layer-1",
        action: { type: "remove_background", layerId: "layer-1" },
        uiContext: { selectedAspectRatio: "1:1", selectedCount: 1 },
      }),
    );

    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    const text = await readResponse(response);
    expect(text).toContain('"type":"data-agent-step"');
    expect(text).toContain('"type":"data-agent-asset"');
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        sessionId: "session-1",
        message: "Remove the background.",
        selectedLayerId: "layer-1",
        action: { type: "remove_background", layerId: "layer-1" },
      }),
    );
  });

  it("prefers the explicit UI locale over the browser Accept-Language", async () => {
    mocks.runAgent.mockResolvedValue({
      runId: "run-1",
      assistantMessage: "暂无可用的生成后端。请在设置中配置 Provider 或本地 Runtime。",
      steps: [],
      artifacts: {},
      backendUsed: { llm: "none", image: "none" },
      generationBackend: "none",
      imageBackend: "none",
      capabilityFix: {
        capability: "text",
        panel: "provider_connections",
        reason: "Select a text model in Settings",
      },
      durationMs: 12,
      stoppedByBudget: false,
    });

    const response = await POST(
      request({ sessionId: "session-1", message: "你好", locale: "zh-CN" }),
    );
    const text = await readResponse(response);

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "zh-CN" }),
    );
    expect(text).toContain("暂无可用的生成后端");
    expect(text).not.toContain('"type":"data-agent-error"');
  });

  it("keeps business failures visible as data-agent-error parts", async () => {
    mocks.runAgent.mockResolvedValue({
      runId: "run-1",
      assistantMessage: "Fal BYOK is not connected.",
      steps: [],
      artifacts: {},
      backendUsed: { llm: "local", image: "none" },
      generationBackend: "none",
      imageBackend: "none",
      error: { message: "Fal BYOK is not connected." },
      durationMs: 12,
      stoppedByBudget: false,
    });

    const response = await POST(
      request({
        sessionId: "session-1",
        message: "Remove the background.",
        selectedLayerId: "layer-1",
      }),
    );

    await expect(readResponse(response)).resolves.toContain('"type":"data-agent-error"');
  });

  it("streams execution exceptions as visible retryable assistant errors", async () => {
    mocks.runAgent.mockRejectedValue(new Error("provider unavailable"));

    const response = await POST(
      request({
        sessionId: "session-1",
        message: "Generate a product shot.",
      }),
    );

    const text = await readResponse(response);
    expect(response.status).toBe(200);
    expect(text).toContain('"type":"data-agent-error"');
    expect(text).toContain('"type":"finish","finishReason":"error"');
  });

  it("accepts an action-only request with no text message (#9)", async () => {
    mocks.runAgent.mockResolvedValue({
      runId: "run-1",
      assistantMessage: "Removed background.",
      steps: [],
      artifacts: {},
      backendUsed: { llm: "none", image: "fal" },
      generationBackend: "byok",
      imageBackend: "byok",
      durationMs: 12,
      stoppedByBudget: false,
    });

    const response = await POST(
      request({
        sessionId: "session-1",
        action: { type: "remove_background", layerId: "layer-1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        message: "",
        action: { type: "remove_background", layerId: "layer-1" },
      }),
    );
  });

  it("still rejects a request with neither a message nor an action", async () => {
    const response = await POST(request({ sessionId: "session-1" }));

    expect(response.status).toBe(400);
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("handles early step-persist rejection without failing the business stream", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.persistAgentTaskStep.mockRejectedValueOnce(new Error("db write rejected"));
    mocks.runAgent.mockImplementation(async (input) => {
      input.onStep?.({
        id: "step-1",
        index: 0,
        toolName: "list_reference_sets",
        category: "brand",
        summary: "Listed sets",
        artifacts: {},
        input: {},
        output: {},
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      return {
        runId: "run-1",
        assistantMessage: "Done.",
        steps: [],
        artifacts: {},
        backendUsed: { llm: "local", image: "none" },
        generationBackend: "local",
        imageBackend: "none",
        durationMs: 12,
        stoppedByBudget: false,
      };
    });

    const response = await POST(request({ sessionId: "session-1", message: "List sets" }));
    const text = await readResponse(response);

    expect(response.status).toBe(200);
    expect(text).toContain('"type":"finish","finishReason":"stop"');
    expect(mocks.finishAgentTask).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("drains pending step writes before terminalizing on exception", async () => {
    let resolvePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => {
      resolvePersist = resolve;
    });
    let persistStarted = false;
    mocks.persistAgentTaskStep.mockImplementation(async () => {
      persistStarted = true;
      await persistGate;
    });
    mocks.runAgent.mockImplementation(async (input) => {
      input.onStep?.({
        id: "step-pending",
        index: 0,
        toolName: "generate_image",
        category: "generate",
        summary: "Generating",
        artifacts: {},
        input: {},
        output: {},
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      throw new Error("provider unavailable");
    });

    const responsePromise = POST(
      request({ sessionId: "session-1", message: "Generate a product shot." }),
    );
    await vi.waitFor(() => expect(persistStarted).toBe(true));
    expect(mocks.failAgentTask).not.toHaveBeenCalled();
    resolvePersist();
    const response = await responsePromise;
    await readResponse(response);

    expect(mocks.persistAgentTaskStep).toHaveBeenCalled();
    expect(mocks.failAgentTask).toHaveBeenCalled();
  });

  it("drains step writes before terminalizing on abort", async () => {
    const controller = new AbortController();
    mocks.runAgent.mockImplementation(async (input) => {
      input.onStep?.({
        id: "step-abort",
        index: 0,
        toolName: "generate_image",
        category: "generate",
        summary: "Started",
        artifacts: {},
        input: {},
        output: {},
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
        },
        body: JSON.stringify({ sessionId: "session-1", message: "Stop soon" }),
        signal: controller.signal,
      }),
    );
    await readResponse(response);

    expect(mocks.persistAgentTaskStep).toHaveBeenCalled();
    expect(mocks.failAgentTask).toHaveBeenCalledWith(
      "task-1",
      expect.anything(),
      expect.objectContaining({ cancelled: true }),
    );
  });
});
