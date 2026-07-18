import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  downloadRemoteBytes,
  fetchConfiguredProviderIds,
  fetchDesktopStatusSnapshot,
  pollUntil,
  tryReadByokKey,
} from "@/lib/server/byok-shared";
import { bumpDesktopStatusRevision } from "@/lib/server/desktop-status-revision";

const temporaryDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const directory of temporaryDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("tryReadByokKey", () => {
  it("reads provider keys from the same environment variables surfaced by desktop status", async () => {
    vi.stubEnv("OPENAI_API_KEY", "  sk-from-env  ");

    await expect(tryReadByokKey("openai")).resolves.toBe("sk-from-env");
  });

  it("supports alternate Gemini environment key names", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "gemini-from-env");

    await expect(tryReadByokKey("gemini")).resolves.toBe("gemini-from-env");
  });

  it("does not treat unknown provider environment variables as configured keys", async () => {
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "");

    await expect(tryReadByokKey("unknown-provider")).resolves.toBeNull();
  });

  it("raises keychain_rate_limited on a 429 instead of reporting a missing key", async () => {
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Secret-read rate limit exceeded (5/min).", { status: 429 })),
    );

    await expect(tryReadByokKey("openai")).rejects.toMatchObject({
      code: "keychain_rate_limited",
      retryable: true,
    });
  });

  it("still reports a genuinely absent key as null (not rate limited)", async () => {
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );

    await expect(tryReadByokKey("openai")).resolves.toBeNull();
  });
});

describe("desktop status cache revision", () => {
  it("bypasses a cached provider snapshot after a cross-bundle mutation marker", async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-status-revision-"));
    temporaryDirs.push(runtimeDir);
    vi.stubEnv("LUNERY_RUNTIME_DIR", runtimeDir);
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          providers: [{ id: "openai", configured: false }],
          local_runtimes: [],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          providers: [{ id: "openai", configured: true }],
          local_runtimes: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    bumpDesktopStatusRevision();
    await expect(fetchConfiguredProviderIds()).resolves.toEqual(new Set());
    await expect(fetchConfiguredProviderIds()).resolves.toEqual(new Set());
    expect(fetchMock).toHaveBeenCalledOnce();

    bumpDesktopStatusRevision();
    await expect(fetchConfiguredProviderIds()).resolves.toEqual(new Set(["openai"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("always refreshes dynamic local runtime state", async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-status-runtime-"));
    temporaryDirs.push(runtimeDir);
    vi.stubEnv("LUNERY_RUNTIME_DIR", runtimeDir);
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          providers: [{ id: "openai", configured: true }],
          local_runtimes: [{ id: "llama-cpp", endpoint: "embedded", status: "idle" }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          providers: [{ id: "openai", configured: true }],
          local_runtimes: [
            { id: "llama-cpp", endpoint: "http://127.0.0.1:9001", status: "ready" },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    bumpDesktopStatusRevision();
    await expect(fetchDesktopStatusSnapshot()).resolves.toMatchObject({
      local_runtimes: [{ status: "idle" }],
    });
    await expect(fetchDesktopStatusSnapshot()).resolves.toMatchObject({
      local_runtimes: [{ status: "ready" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("downloadRemoteBytes", () => {
  it("preserves a caller abort instead of wrapping it as a provider error", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      downloadRemoteBytes("https://example.com/model.glb", {
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("pollUntil", () => {
  it("aborts while waiting between provider status checks", async () => {
    const controller = new AbortController();
    await expect(
      pollUntil({
        fetcher: async () => {
          controller.abort();
          return "pending";
        },
        isDone: () => false,
        deadlineMs: 10_000,
        intervalMs: 1_000,
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
