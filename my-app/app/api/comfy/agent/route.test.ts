import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireDesktopBridge: vi.fn(),
  ensureWorkspaceRestoreReconciled: vi.fn(),
  requireLocalWorkspaceOwner: vi.fn(),
  getLocalWorkspacePreferences: vi.fn(),
  getActiveComfyConnection: vi.fn(),
  getComfyConnection: vi.fn(),
  validateComfyEndpoint: vi.fn(),
  resolveStudioRuntimeSupply: vi.fn(),
  resolveAgentLanguageModel: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock("@/lib/server/desktop-bridge", () => ({
  requireDesktopBridge: mocks.requireDesktopBridge,
  proxyToBridge: vi.fn(),
}));
vi.mock("@/lib/server/workspace-restore-journal", () => ({
  ensureWorkspaceRestoreReconciled: mocks.ensureWorkspaceRestoreReconciled,
}));
vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
  getLocalWorkspacePreferences: mocks.getLocalWorkspacePreferences,
}));
vi.mock("@/lib/server/comfy-connection-store", () => ({
  getActiveComfyConnection: mocks.getActiveComfyConnection,
  getComfyConnection: mocks.getComfyConnection,
}));
vi.mock("@/lib/server/comfy-endpoint", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/server/comfy-endpoint")>();
  return { ...actual, validateComfyEndpoint: mocks.validateComfyEndpoint };
});
vi.mock("@/lib/server/runtime-supply", () => ({
  resolveStudioRuntimeSupply: mocks.resolveStudioRuntimeSupply,
}));
vi.mock("@/lib/server/agent/runtime/resolve-language-model", () => ({
  resolveAgentLanguageModel: mocks.resolveAgentLanguageModel,
}));
// Real UIMessage stream plumbing, stubbed model call.
vi.mock("ai", async (importActual) => {
  const actual = await importActual<typeof import("ai")>();
  return { ...actual, streamText: mocks.streamText };
});

import { POST } from "@/app/api/comfy/agent/route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/comfy/agent", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

function userMessage(text: string) {
  return { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text }] }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireDesktopBridge.mockReturnValue({ url: "http://127.0.0.1:49152", token: "t" });
  mocks.ensureWorkspaceRestoreReconciled.mockResolvedValue(undefined);
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
  mocks.getLocalWorkspacePreferences.mockResolvedValue({ defaultTextModel: "local:some-model" });
  mocks.getActiveComfyConnection.mockReturnValue({
    id: "gmk",
    name: "gmk",
    endpoint: "http://127.0.0.1:8188",
  });
  mocks.validateComfyEndpoint.mockResolvedValue({ url: "http://127.0.0.1:8188" });
  mocks.resolveAgentLanguageModel.mockResolvedValue({ model: {} });
});

describe("/api/comfy/agent", () => {
  it("fails before streaming with 503 llm_backend_missing when no text model is configured", async () => {
    mocks.getLocalWorkspacePreferences.mockResolvedValue({ defaultTextModel: "" });
    mocks.resolveStudioRuntimeSupply.mockResolvedValue({
      text: { backend: "none" },
      backendUsed: { llm: "none", image: "none" },
    });

    const response = await POST(request(userMessage("hi")));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "llm_backend_missing" });
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it("returns 400 no_connection when no ComfyUI is attached", async () => {
    mocks.getActiveComfyConnection.mockReturnValue(undefined);

    const response = await POST(request(userMessage("hi")));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "no_connection" });
    expect(mocks.resolveStudioRuntimeSupply).not.toHaveBeenCalled();
  });

  it("streams data-agent-status and the model text on the happy path", async () => {
    mocks.resolveStudioRuntimeSupply.mockResolvedValue({
      text: { backend: "local", endpoint: "http://127.0.0.1:1234", modelId: "m" },
      backendUsed: { llm: "local", image: "none" },
    });
    mocks.streamText.mockReturnValue({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Hello from Luna" };
      })(),
    });

    const response = await POST(request(userMessage("what's on the canvas?")));

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"type":"data-agent-status"');
    expect(text).toContain("Hello from Luna");
    expect(text).toContain('"type":"data-agent-backend"');
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
  });
});
