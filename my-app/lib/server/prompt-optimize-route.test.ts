import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  optimizePrompt: vi.fn(),
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
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
});
