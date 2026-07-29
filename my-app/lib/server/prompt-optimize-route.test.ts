import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  getLocalWorkspacePreferences: vi.fn(),
  optimizePrompt: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
  getLocalWorkspacePreferences: mocks.getLocalWorkspacePreferences,
}));

vi.mock("@/lib/server/prompt-optimizer", () => ({
  optimizePrompt: mocks.optimizePrompt,
}));

import { POST } from "@/app/api/prompts/optimize/route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/prompts/optimize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "user-1" });
  mocks.getLocalWorkspacePreferences.mockResolvedValue({
    defaultTextModel: "byok:openai:gpt-4.1-mini",
  });
  mocks.optimizePrompt.mockResolvedValue({
    provider: "local",
    model: "llama",
    optimizedPrompt: "Optimized prompt.",
  });
});

describe("/api/prompts/optimize", () => {
  it("passes the request abort signal into prompt optimization", async () => {
    const req = request({
      prompt: "portrait",
      mode: "photo",
    });

    await POST(req);

    expect(mocks.optimizePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "portrait",
        mode: "photo",
        abortSignal: req.signal,
      }),
    );
  });

  it("uses the profile-saved text model instead of a client-supplied model", async () => {
    const req = request({
      prompt: "portrait",
      mode: "photo",
      textModelId: "byok:anthropic:untrusted-client-choice",
    });

    await POST(req);

    expect(mocks.optimizePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        textModelId: "byok:openai:gpt-4.1-mini",
      }),
    );
    expect(mocks.getLocalWorkspacePreferences).toHaveBeenCalledWith("user-1");
  });
});
