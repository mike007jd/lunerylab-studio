import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  fetchDesktopStatusSnapshot: vi.fn(),
  listByokConnectionMeta: vi.fn(),
  isKnownLocalImageModelId: vi.fn(),
  resolveInstalledSdCppImageModel: vi.fn(),
}));

vi.mock("@/lib/desktop-runtime", () => ({
  isDesktopRuntime: () => true,
}));

vi.mock("@/lib/server/local-image-model-catalog", () => ({
  isKnownLocalImageModelId: mocks.isKnownLocalImageModelId,
  resolveInstalledSdCppImageModel: mocks.resolveInstalledSdCppImageModel,
}));

vi.mock("@/lib/server/byok-connection-store", () => ({
  listByokConnectionMeta: mocks.listByokConnectionMeta,
}));

vi.mock("@/lib/server/byok-shared", () => ({
  fetchDesktopStatusSnapshot: mocks.fetchDesktopStatusSnapshot,
  isByokModelSelectionId: () => false,
  parseByokModelSelection: () => null,
}));

import {
  resolveLocalImageRuntimeAvailability,
  resolveTextRuntimeSupply,
} from "@/lib/server/runtime-supply";

describe("resolveTextRuntimeSupply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LUNERY_DESKTOP_BRIDGE_URL = "http://127.0.0.1:49100";
    process.env.LUNERY_DESKTOP_BRIDGE_TOKEN = "test-token";
    mocks.listByokConnectionMeta.mockReturnValue({});
    mocks.fetchDesktopStatusSnapshot.mockResolvedValue({
      providers: [],
      local_runtimes: [
        {
          id: "llama-cpp",
          endpoint: "http://127.0.0.1:9001",
          status: "ready",
        },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LUNERY_DESKTOP_BRIDGE_URL;
    delete process.env.LUNERY_DESKTOP_BRIDGE_TOKEN;
  });

  it("discovers models after the bridge confirms a local runtime is reachable", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://127.0.0.1:49100/runtime-probe") {
        return Response.json({
          endpoint: "http://127.0.0.1:9001",
          reachable: true,
          models: [],
          latency_ms: 3,
        });
      }
      if (url === "http://127.0.0.1:9001/api/tags") {
        return Response.json({ models: [{ name: "local-text-model" }] });
      }
      if (url === "http://127.0.0.1:9001/v1/models") {
        return new Response("not found", { status: 404 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveTextRuntimeSupply("local:local-text-model")).resolves.toMatchObject({
      backend: "local",
      endpoint: "http://127.0.0.1:9001",
      modelId: "local-text-model",
    });
  });

  it("continues past a reachable runtime with no models", async () => {
    mocks.fetchDesktopStatusSnapshot.mockResolvedValue({
      providers: [],
      local_runtimes: [
        { id: "mlx", endpoint: "http://127.0.0.1:9002", status: "ready" },
        { id: "llama-cpp", endpoint: "http://127.0.0.1:9003", status: "ready" },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/runtime-probe")) {
        return Response.json({
          endpoint: "unused-by-supply",
          reachable: true,
          latency_ms: 2,
        });
      }
      if (url === "http://127.0.0.1:9003/v1/models") {
        return Response.json({ data: [{ id: "second-runtime-model" }] });
      }
      return new Response("not found", { status: 404 });
    }));

    await expect(resolveTextRuntimeSupply("local:second-runtime-model")).resolves.toMatchObject({
      backend: "local",
      endpoint: "http://127.0.0.1:9003",
      modelId: "second-runtime-model",
    });
  });

  it("never runs a different loaded model than the one the user selected", async () => {
    // Two runtimes online; the first-probed endpoint hosts model B, but the
    // user selected model A which lives on the second endpoint. Unique ports
    // avoid the module-level probe cache carrying over from earlier tests.
    mocks.fetchDesktopStatusSnapshot.mockResolvedValue({
      providers: [],
      local_runtimes: [
        { id: "mlx", endpoint: "http://127.0.0.1:9202", status: "ready" },
        { id: "llama-cpp", endpoint: "http://127.0.0.1:9203", status: "ready" },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/runtime-probe")) {
        return Response.json({ endpoint: "unused", reachable: true, latency_ms: 1 });
      }
      if (url === "http://127.0.0.1:9202/v1/models") {
        return Response.json({ data: [{ id: "model-b" }] });
      }
      if (url === "http://127.0.0.1:9203/v1/models") {
        return Response.json({ data: [{ id: "model-a" }] });
      }
      return new Response("not found", { status: 404 });
    }));

    await expect(resolveTextRuntimeSupply("local:model-a")).resolves.toMatchObject({
      backend: "local",
      endpoint: "http://127.0.0.1:9203",
      modelId: "model-a",
    });
  });

  it("reports selected_model_not_loaded instead of falling back to another model", async () => {
    mocks.fetchDesktopStatusSnapshot.mockResolvedValue({
      providers: [],
      local_runtimes: [
        { id: "llama-cpp", endpoint: "http://127.0.0.1:9303", status: "ready" },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/runtime-probe")) {
        return Response.json({ endpoint: "unused", reachable: true, latency_ms: 1 });
      }
      if (url === "http://127.0.0.1:9303/v1/models") {
        return Response.json({ data: [{ id: "some-other-model" }] });
      }
      return new Response("not found", { status: 404 });
    }));

    await expect(resolveTextRuntimeSupply("local:model-the-user-wants")).resolves.toMatchObject({
      backend: "none",
      fix: { reason: expect.stringContaining("is not loaded") },
    });
  });

  it("matches Ollama :latest tags against a bare selected id", async () => {
    mocks.fetchDesktopStatusSnapshot.mockResolvedValue({
      providers: [],
      local_runtimes: [
        { id: "llama-cpp", endpoint: "http://127.0.0.1:9403", status: "ready" },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/runtime-probe")) {
        return Response.json({ endpoint: "unused", reachable: true, latency_ms: 1 });
      }
      if (url === "http://127.0.0.1:9403/api/tags") {
        return Response.json({ models: [{ name: "llama3.2:latest" }] });
      }
      return new Response("not found", { status: 404 });
    }));

    await expect(resolveTextRuntimeSupply("local:llama3.2")).resolves.toMatchObject({
      backend: "local",
      endpoint: "http://127.0.0.1:9403",
      modelId: "llama3.2:latest",
    });
  });

  it("reports local image runtime families independently", async () => {
    mocks.fetchDesktopStatusSnapshot.mockResolvedValue({
      providers: [],
      local_runtimes: [{ id: "sd-cpp", endpoint: "embedded-sdcpp", status: "idle" }],
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/runtime-probe")) {
        return Response.json({
          endpoint: "http://127.0.0.1:8188",
          reachable: true,
          latency_ms: 2,
        });
      }
      return new Response("not found", { status: 404 });
    }));

    await expect(resolveLocalImageRuntimeAvailability()).resolves.toEqual({
      sdCpp: false,
      comfyUi: true,
    });
  });
});
