import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The store is server-only and derives its file path from LUNERY_CONFIG_DIR at
// module load. Redirect that to a temp dir per test and reset the module
// registry so cross-bundle tests can keep references to independent module
// instances while sharing one profile file.
vi.mock("server-only", () => ({}));

let tmpDir: string;
let storeFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "byok-store-"));
  vi.stubEnv("LUNERY_CONFIG_DIR", tmpDir);
  storeFile = path.join(tmpDir, "provider-connections.json");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function loadStore() {
  return import("@/lib/server/byok-connection-store");
}

function writeFixture(data: unknown) {
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(data), "utf8");
}

describe("byok-connection-store per-capability models (#1)", () => {
  it("keeps text and image model ids separate for one OpenAI connection", async () => {
    const store = await loadStore();
    store.setByokConnectionMeta("openai", {
      endpoint: "https://api.openai.com/v1",
      models: { text: "gpt-5-chat-latest", imageGenerate: "gpt-image-1.5" },
      updatedAt: new Date().toISOString(),
    });

    // The text entry and the image entry each read their own slot — no bleed.
    expect(store.getByokConnectionModelId("openai", "text")).toBe("gpt-5-chat-latest");
    expect(store.getByokConnectionModelId("openai", "imageGenerate")).toBe("gpt-image-1.5");
    // An unconfigured slot stays empty (no silent fallback to the other model).
    expect(store.getByokConnectionModelId("openai", "video")).toBeUndefined();
  });

  it("persists models to disk and reloads them after a fresh module load", async () => {
    const first = await loadStore();
    first.setByokConnectionMeta("fal", {
      endpoint: "https://queue.fal.run",
      models: { imageGenerate: "fal-ai/flux-pro/v1.1", video: "fal-ai/some-video" },
      updatedAt: new Date().toISOString(),
    });

    vi.resetModules();
    const reloaded = await loadStore();
    expect(reloaded.getByokConnectionModelId("fal", "imageGenerate")).toBe("fal-ai/flux-pro/v1.1");
    expect(reloaded.getByokConnectionModelId("fal", "video")).toBe("fal-ai/some-video");
  });

  it("keeps an already-loaded route bundle in sync with writes from another bundle", async () => {
    const bootstrapBundle = await loadStore();
    expect(bootstrapBundle.listByokConnectionMeta()).toEqual({});

    vi.resetModules();
    const settingsBundle = await loadStore();
    settingsBundle.setByokConnectionMeta("openai", {
      endpoint: "https://api.openai.com/v1",
      models: { text: "gpt-5-chat-latest" },
      updatedAt: "2026-07-13T00:00:00.000Z",
    });

    expect(bootstrapBundle.getByokConnectionModelId("openai", "text")).toBe(
      "gpt-5-chat-latest",
    );
    expect(bootstrapBundle.listByokConnectionMeta()).toHaveProperty("openai");

    settingsBundle.deleteByokConnectionMeta("openai");
    expect(bootstrapBundle.listByokConnectionMeta()).toEqual({});
  });

  it("throws and leaves memory untouched when the write fails (#4)", async () => {
    // Point the store dir at a path *under a regular file* so mkdir/write fails
    // deterministically (ENOTDIR) — no fs mocking needed.
    const blocker = path.join(tmpDir, "blocker-file");
    fs.writeFileSync(blocker, "not a dir");
    vi.stubEnv("LUNERY_CONFIG_DIR", blocker);
    vi.resetModules();
    const store = await loadStore();

    expect(() =>
      store.setByokConnectionMeta("anthropic", {
        endpoint: "https://api.anthropic.com",
        models: { text: "claude-opus-4-8" },
        updatedAt: new Date().toISOString(),
      }),
    ).toThrow();
    // No false success: the failed write must not be visible in memory.
    expect(store.getByokConnectionModelId("anthropic", "text")).toBeUndefined();
  });

  it("rejects slots a provider does not expose on write", async () => {
    const store = await loadStore();
    // normalizeByokModels keeps known role keys, but anthropic only resolves
    // `text`; a stray video slot must never be readable as a video model.
    store.setByokConnectionMeta("anthropic", {
      endpoint: "https://api.anthropic.com",
      models: { text: "claude-opus-4-8" },
      updatedAt: new Date().toISOString(),
    });
    expect(store.getByokConnectionModelId("anthropic", "text")).toBe("claude-opus-4-8");
    expect(store.getByokConnectionModelId("anthropic", "video")).toBeUndefined();
  });
});

describe("byok-connection-store model slots", () => {
  it("ignores old single modelId fields and keeps the connection endpoint", async () => {
    writeFixture({
      openai: { endpoint: "https://api.openai.com/v1", modelId: "gpt-image-1.5" },
    });
    const store = await loadStore();
    expect(store.getByokConnectionModelId("openai", "text")).toBeUndefined();
    expect(store.getByokConnectionModelId("openai", "imageGenerate")).toBeUndefined();
    expect(store.getByokConnectionMeta("openai")?.endpoint).toBe("https://api.openai.com/v1");
  });

  it("reads the new models map straight through", async () => {
    writeFixture({
      openai: {
        endpoint: "https://api.openai.com/v1",
        models: { text: "gpt-5-chat-latest", imageGenerate: "gpt-image-1.5" },
      },
    });
    const store = await loadStore();
    expect(store.getByokConnectionModelId("openai", "text")).toBe("gpt-5-chat-latest");
    expect(store.getByokConnectionModelId("openai", "imageGenerate")).toBe("gpt-image-1.5");
  });
});
