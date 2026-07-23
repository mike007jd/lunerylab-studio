import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireDesktopBridge: vi.fn(),
  findByokProvider: vi.fn(),
  getByokConnectionMeta: vi.fn(),
  tryReadByokKey: vi.fn(),
  validateProviderEndpoint: vi.fn(),
}));

vi.mock("@/lib/server/desktop-bridge", () => ({
  requireDesktopBridge: mocks.requireDesktopBridge,
}));

vi.mock("@/lib/byok-providers", () => ({
  findByokProvider: mocks.findByokProvider,
}));

vi.mock("@/lib/server/byok-connection-store", () => ({
  getByokConnectionMeta: mocks.getByokConnectionMeta,
}));

vi.mock("@/lib/server/byok-shared", () => ({
  tryReadByokKey: mocks.tryReadByokKey,
  validateProviderEndpoint: mocks.validateProviderEndpoint,
}));

import { POST } from "@/app/api/desktop-runtime/test-connection/route";
import { ApiError } from "@/lib/server/errors";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/desktop-runtime/test-connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const providerMeta = {
  id: "openai",
  label: "OpenAI",
  defaultEndpoint: "https://api.openai.test/v1",
};

describe("/api/desktop-runtime/test-connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDesktopBridge.mockReturnValue({ url: "http://127.0.0.1:49152", token: "token" });
    mocks.findByokProvider.mockReturnValue(providerMeta);
    mocks.getByokConnectionMeta.mockReturnValue({ endpoint: "https://saved.example/v1" });
    mocks.tryReadByokKey.mockResolvedValue(null);
    mocks.validateProviderEndpoint.mockImplementation(async (value: string) => ({ url: value }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tests a draft key and endpoint without first saving the key", async () => {
    const response = await POST(request({
      providerId: "openai",
      apiKey: "  sk-draft  ",
      endpoint: " https://draft.example/v1 ",
    }));

    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mocks.tryReadByokKey).not.toHaveBeenCalled();
    expect(mocks.validateProviderEndpoint).toHaveBeenCalledWith("https://draft.example/v1");
    expect(fetch).toHaveBeenCalledWith(
      "https://draft.example/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-draft" },
      }),
    );
  });

  it("falls back to the saved key when no draft key is supplied", async () => {
    mocks.tryReadByokKey.mockResolvedValue("saved-key");

    const response = await POST(request({ providerId: "openai" }));

    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mocks.validateProviderEndpoint).toHaveBeenCalledWith("https://saved.example/v1");
    expect(fetch).toHaveBeenCalledWith(
      "https://saved.example/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer saved-key" },
      }),
    );
  });

  it("returns a structured connection failure when the keychain is unavailable", async () => {
    mocks.tryReadByokKey.mockRejectedValue(new ApiError({
      status: 503,
      code: "keychain_unavailable",
      message: 'The system keychain is unavailable for provider "openai". Unlock it and retry.',
      retryable: true,
    }));

    const response = await POST(request({ providerId: "openai" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      latency_ms: 0,
      error: 'The system keychain is unavailable for provider "openai". Unlock it and retry.',
    });
    expect(mocks.validateProviderEndpoint).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
