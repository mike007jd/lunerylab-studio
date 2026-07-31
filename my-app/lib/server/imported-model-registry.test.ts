import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImportedModelRecord } from "@/lib/server/imported-model-registry";

let tmpDir: string;
let homeDir: string;
let modelsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "imported-model-registry-"));
  homeDir = path.join(tmpDir, "home");
  modelsDir = path.join(tmpDir, "profile", "models");
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("LUNERY_MODELS_DIR", modelsDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function record(overrides: Partial<ImportedModelRecord> = {}): ImportedModelRecord {
  return {
    id: "imported-llama-cpp-demo-12345678",
    label: "Demo",
    source: "huggingface-url",
    runtimeTarget: "llama-cpp",
    capability: "planner-llm",
    format: "gguf",
    fileName: "demo.gguf",
    modelPath: path.join(modelsDir, "llama-cpp", "demo.gguf"),
    sizeBytes: 123,
    sha256: null,
    status: "ready",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("imported-model-registry profile paths", () => {
  it("uses the Lunery profile models directory for new cache paths", async () => {
    const registry = await import("@/lib/server/imported-model-registry");
    expect(registry.modelsCacheRoot()).toBe(modelsDir);
    expect(registry.importedModelsRegistryPath()).toBe(path.join(modelsDir, "imported-models.json"));
    expect(registry.importedModelDownloadDest("llama-cpp", "abc", "demo.gguf")).toBe(
      path.join(modelsDir, "llama-cpp", "imported", "abc", "demo.gguf"),
    );
  });

  it("uses the profile model file path even when old cache files exist", async () => {
    const registry = await import("@/lib/server/imported-model-registry");
    const primary = path.join(modelsDir, "llama-cpp", "demo.gguf");
    const oldCache = path.join(homeDir, ".cache", "lunerylab", "models", "llama-cpp", "demo.gguf");
    fs.mkdirSync(path.dirname(oldCache), { recursive: true });
    fs.writeFileSync(oldCache, "old-cache");

    expect(registry.modelCachePath("llama-cpp", "demo.gguf")).toBe(primary);

    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(primary, "primary");
    expect(registry.modelCachePath("llama-cpp", "demo.gguf")).toBe(primary);
  });

  it("does not read imported-model registries from old cache roots", async () => {
    const oldRegistryPath = path.join(homeDir, ".cache", "lunerylab", "models", "imported-models.json");
    fs.mkdirSync(path.dirname(oldRegistryPath), { recursive: true });
    fs.writeFileSync(oldRegistryPath, JSON.stringify([record()]), "utf8");

    const registry = await import("@/lib/server/imported-model-registry");
    const records = await registry.readImportedModels();

    expect(records).toHaveLength(0);
    expect(fs.existsSync(path.join(modelsDir, "imported-models.json"))).toBe(false);
  });

  it("removes one imported record without touching the remaining registry", async () => {
    const registry = await import("@/lib/server/imported-model-registry");
    await registry.upsertImportedModel(record());
    await registry.upsertImportedModel(record({
      id: "imported-llama-cpp-other-87654321",
      fileName: "other.gguf",
      modelPath: path.join(modelsDir, "llama-cpp", "other.gguf"),
    }));

    await expect(registry.removeImportedModel(record().id)).resolves.toMatchObject({ id: record().id });
    await expect(registry.readImportedModels()).resolves.toEqual([
      expect.objectContaining({ id: "imported-llama-cpp-other-87654321" }),
    ]);
  });

  it("captures a stable filesystem identity for a local-path import", async () => {
    const modelPath = path.join(tmpDir, "external", "demo.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "model");
    const registry = await import("@/lib/server/imported-model-registry");

    const resolved = await registry.resolveLocalModelPath(modelPath);

    expect(resolved).toMatchObject({
      modelPath,
      fileName: "demo.gguf",
      sizeBytes: 5,
      fileIdentity: {
        device: expect.any(String),
        inode: expect.any(String),
        sizeBytes: "5",
        modifiedAtNs: expect.any(String),
      },
    });
  });

  it.runIf(process.platform !== "win32")("rejects a symlink as a local model identity", async () => {
    const target = path.join(tmpDir, "target.gguf");
    const linked = path.join(tmpDir, "linked.gguf");
    fs.writeFileSync(target, "model");
    fs.symlinkSync(target, linked);
    const registry = await import("@/lib/server/imported-model-registry");

    await expect(registry.resolveLocalModelPath(linked)).resolves.toEqual({
      error: "The model path must point to a file.",
    });
  });
});
