import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImportedModelRecord } from "@/lib/server/imported-model-registry";

vi.mock("server-only", () => ({}));

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
  vi.restoreAllMocks();
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

  it("recovers a staged external deletion after a process crash", async () => {
    const modelPath = path.join(tmpDir, "external", "recover.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "original-model");
    const registry = await import("@/lib/server/imported-model-registry");
    const resolved = await registry.resolveLocalModelPath(modelPath);
    if ("error" in resolved) throw new Error(resolved.error);
    const imported = record({
      id: "imported-llama-cpp-recover-12345678",
      source: "local-path",
      modelPath,
      fileName: path.basename(modelPath),
      sizeBytes: resolved.sizeBytes,
      fileIdentity: resolved.fileIdentity,
    });
    await registry.upsertImportedModel(imported);

    const staged = await registry.stageImportedExternalModelFile(imported);
    expect(staged.hadFile).toBe(true);
    expect(fs.existsSync(modelPath)).toBe(false);
    expect(fs.existsSync(staged.stagedPath)).toBe(true);

    await registry.reconcileExternalModelDeleteJournals();

    expect(fs.readFileSync(modelPath, "utf8")).toBe("original-model");
    expect(fs.existsSync(staged.stagedPath)).toBe(false);
    await expect(registry.findImportedModel(imported.id)).resolves.toMatchObject({
      modelPath,
    });
  });

  it("never overwrites a replacement while rolling back an external deletion", async () => {
    const modelPath = path.join(tmpDir, "external", "collision.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "original-model");
    const registry = await import("@/lib/server/imported-model-registry");
    const resolved = await registry.resolveLocalModelPath(modelPath);
    if ("error" in resolved) throw new Error(resolved.error);
    const imported = record({
      id: "imported-llama-cpp-collision-12345678",
      source: "local-path",
      modelPath,
      fileName: path.basename(modelPath),
      sizeBytes: resolved.sizeBytes,
      fileIdentity: resolved.fileIdentity,
    });
    await registry.upsertImportedModel(imported);
    const staged = await registry.stageImportedExternalModelFile(imported);
    fs.writeFileSync(modelPath, "replacement-model");

    const restored = await registry.rollbackImportedExternalModelFile(staged, imported);
    await registry.upsertImportedModel(restored);
    await registry.finishImportedExternalModelRollback(staged);

    expect(fs.readFileSync(modelPath, "utf8")).toBe("replacement-model");
    expect(restored.modelPath).not.toBe(modelPath);
    expect(fs.readFileSync(restored.modelPath, "utf8")).toBe("original-model");
  });

  it("unregisters a changed external file without staging or deleting it", async () => {
    const modelPath = path.join(tmpDir, "external", "changed.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "original-model");
    const registry = await import("@/lib/server/imported-model-registry");
    const resolved = await registry.resolveLocalModelPath(modelPath);
    if ("error" in resolved) throw new Error(resolved.error);
    const imported = record({
      id: "imported-llama-cpp-changed-12345678",
      source: "local-path",
      modelPath,
      fileName: path.basename(modelPath),
      sizeBytes: resolved.sizeBytes,
      fileIdentity: resolved.fileIdentity,
    });
    fs.writeFileSync(modelPath, "replacement-model-with-new-identity");

    const staged = await registry.stageImportedExternalModelFile(imported);

    expect(staged).toMatchObject({ hadFile: false, preservedChangedFile: true });
    expect(fs.readFileSync(modelPath, "utf8")).toBe("replacement-model-with-new-identity");
  });

  it("restores a replacement raced into the path immediately before staging", async () => {
    const modelPath = path.join(tmpDir, "external", "raced.gguf");
    const displacedPath = path.join(tmpDir, "external", "displaced.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "original-model");
    const registry = await import("@/lib/server/imported-model-registry");
    const resolved = await registry.resolveLocalModelPath(modelPath);
    if ("error" in resolved) throw new Error(resolved.error);
    const imported = record({
      id: "imported-llama-cpp-raced-12345678",
      source: "local-path",
      modelPath,
      fileName: path.basename(modelPath),
      sizeBytes: resolved.sizeBytes,
      fileIdentity: resolved.fileIdentity,
    });
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementationOnce(async (source, destination) => {
      fs.renameSync(modelPath, displacedPath);
      fs.writeFileSync(modelPath, "replacement-model");
      await rename(source, destination);
    });

    const staged = await registry.stageImportedExternalModelFile(imported);

    expect(staged).toMatchObject({ hadFile: false, preservedChangedFile: true });
    expect(fs.readFileSync(modelPath, "utf8")).toBe("replacement-model");
    expect(fs.readFileSync(displacedPath, "utf8")).toBe("original-model");
    expect(fs.readdirSync(path.dirname(modelPath))).not.toEqual(
      expect.arrayContaining([expect.stringContaining(".lunery-delete-")]),
    );
  });

  it("publishes the initial delete journal atomically", async () => {
    const modelPath = path.join(tmpDir, "external", "journal.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "model");
    const registry = await import("@/lib/server/imported-model-registry");
    const resolved = await registry.resolveLocalModelPath(modelPath);
    if ("error" in resolved) throw new Error(resolved.error);
    const imported = record({
      id: "imported-llama-cpp-journal-12345678",
      source: "local-path",
      modelPath,
      fileName: path.basename(modelPath),
      sizeBytes: resolved.sizeBytes,
      fileIdentity: resolved.fileIdentity,
    });
    vi.spyOn(fs.promises, "link").mockRejectedValueOnce(
      Object.assign(new Error("interrupted publish"), { code: "EIO" }),
    );

    await expect(registry.stageImportedExternalModelFile(imported)).rejects.toMatchObject({
      code: "external_model_file_delete_failed",
    });

    const journalDir = path.join(modelsDir, ".external-delete-journal");
    expect(fs.existsSync(modelPath)).toBe(true);
    expect(fs.existsSync(journalDir) ? fs.readdirSync(journalDir) : []).toEqual([]);
  });

  it("recovers a raced replacement after a crash before its identity is journaled", async () => {
    const modelPath = path.join(tmpDir, "external", "crash-raced.gguf");
    const displacedPath = path.join(tmpDir, "external", "crash-displaced.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "original-model");
    const registry = await import("@/lib/server/imported-model-registry");
    const resolved = await registry.resolveLocalModelPath(modelPath);
    if ("error" in resolved) throw new Error(resolved.error);
    const imported = record({
      id: "imported-llama-cpp-crash-raced-12345678",
      source: "local-path",
      modelPath,
      fileName: path.basename(modelPath),
      sizeBytes: resolved.sizeBytes,
      fileIdentity: resolved.fileIdentity,
    });
    await registry.upsertImportedModel(imported);
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementationOnce(async (source, destination) => {
      fs.renameSync(modelPath, displacedPath);
      fs.writeFileSync(modelPath, "replacement-model");
      await rename(source, destination);
    });
    const lstat = fs.promises.lstat.bind(fs.promises);
    let crashAtStagedIdentity = true;
    vi.spyOn(fs.promises, "lstat").mockImplementation(async (target, options) => {
      if (crashAtStagedIdentity && String(target).includes(".lunery-delete-")) {
        crashAtStagedIdentity = false;
        throw Object.assign(new Error("simulated crash boundary"), { code: "EIO" });
      }
      return lstat(target, options as { bigint: true });
    });

    await expect(registry.stageImportedExternalModelFile(imported)).rejects.toMatchObject({
      code: "external_model_delete_rollback_failed",
    });
    vi.restoreAllMocks();
    expect(fs.existsSync(modelPath)).toBe(false);
    expect(fs.readdirSync(path.dirname(modelPath))).toEqual(
      expect.arrayContaining([expect.stringContaining(".lunery-delete-")]),
    );

    await registry.reconcileExternalModelDeleteJournals();

    expect(fs.readFileSync(modelPath, "utf8")).toBe("replacement-model");
    expect(fs.readFileSync(displacedPath, "utf8")).toBe("original-model");
    expect(fs.readdirSync(path.dirname(modelPath))).not.toEqual(
      expect.arrayContaining([expect.stringContaining(".lunery-delete-")]),
    );
  });

  it("preserves a raced replacement when recovery crashes after identity journaling", async () => {
    const modelPath = path.join(tmpDir, "external", "recovery-crash.gguf");
    const displacedPath = path.join(tmpDir, "external", "recovery-displaced.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "original-model");
    const registry = await import("@/lib/server/imported-model-registry");
    const resolved = await registry.resolveLocalModelPath(modelPath);
    if ("error" in resolved) throw new Error(resolved.error);
    const imported = record({
      id: "imported-llama-cpp-recovery-crash-12345678",
      source: "local-path",
      modelPath,
      fileName: path.basename(modelPath),
      sizeBytes: resolved.sizeBytes,
      fileIdentity: resolved.fileIdentity,
    });
    await registry.upsertImportedModel(imported);
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementationOnce(async (source, destination) => {
      fs.renameSync(modelPath, displacedPath);
      fs.writeFileSync(modelPath, "replacement-model");
      await rename(source, destination);
    });
    const link = fs.promises.link.bind(fs.promises);
    let linkCalls = 0;
    vi.spyOn(fs.promises, "link").mockImplementation(async (source, destination) => {
      linkCalls += 1;
      if (linkCalls === 2) {
        throw Object.assign(new Error("simulated recovery crash"), { code: "EIO" });
      }
      await link(source, destination);
    });

    await expect(registry.stageImportedExternalModelFile(imported)).rejects.toMatchObject({
      code: "external_model_delete_rollback_failed",
    });
    vi.restoreAllMocks();
    await registry.removeImportedModel(imported.id);

    await registry.reconcileExternalModelDeleteJournals();

    expect(fs.readFileSync(modelPath, "utf8")).toBe("replacement-model");
    expect(fs.readFileSync(displacedPath, "utf8")).toBe("original-model");
    await expect(registry.findImportedModel(imported.id)).resolves.toBeUndefined();
  });

  it("fails closed on malformed registry JSON instead of treating it as empty", async () => {
    const registryPath = path.join(modelsDir, "imported-models.json");
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.writeFileSync(registryPath, "{not-json", "utf8");
    const registry = await import("@/lib/server/imported-model-registry");

    await expect(registry.readImportedModels()).rejects.toMatchObject({
      code: "imported_model_registry_corrupt",
    });
    expect(fs.readFileSync(registryPath, "utf8")).toBe("{not-json");
  });

  it("fails closed when any array record is invalid", async () => {
    const registryPath = path.join(modelsDir, "imported-models.json");
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify([record(), { id: "truncated" }]), "utf8");
    const registry = await import("@/lib/server/imported-model-registry");

    await expect(registry.readImportedModels()).rejects.toMatchObject({
      code: "imported_model_registry_corrupt",
    });
    expect(JSON.parse(fs.readFileSync(registryPath, "utf8"))).toHaveLength(2);
  });

  it("serializes concurrent upserts so no accepted record is lost", async () => {
    const registry = await import("@/lib/server/imported-model-registry");
    const first = record({ id: "imported-llama-cpp-a-11111111", fileName: "a.gguf" });
    const second = record({
      id: "imported-llama-cpp-b-22222222",
      fileName: "b.gguf",
      modelPath: path.join(modelsDir, "llama-cpp", "b.gguf"),
      createdAt: "2026-07-01T00:00:01.000Z",
    });

    await Promise.all([
      registry.upsertImportedModel(first),
      registry.upsertImportedModel(second),
    ]);

    const records = await registry.readImportedModels();
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id }),
        expect.objectContaining({ id: second.id }),
      ]),
    );
    expect(records).toHaveLength(2);
  });

  it("surfaces injected write failures without publishing a partial registry", async () => {
    const registry = await import("@/lib/server/imported-model-registry");
    await registry.upsertImportedModel(record());
    registry.__importedModelRegistryTestHooks.beforeWrite = () => {
      throw new Error("injected registry write failure");
    };

    await expect(
      registry.upsertImportedModel(record({
        id: "imported-llama-cpp-fail-99999999",
        fileName: "fail.gguf",
      })),
    ).rejects.toThrow("injected registry write failure");

    registry.__importedModelRegistryTestHooks.beforeWrite = null;
    await expect(registry.readImportedModels()).resolves.toEqual([
      expect.objectContaining({ id: record().id }),
    ]);
  });

  it("restores the prior record after a failed queued bridge start", async () => {
    const registry = await import("@/lib/server/imported-model-registry");
    const previous = record({ status: "ready", jobId: undefined });
    await registry.upsertImportedModel(previous);
    const queued = record({
      status: "queued",
      jobId: "job-new",
      createdAt: "2026-07-01T00:01:00.000Z",
    });

    const mutation = await registry.queueImportedModel(queued);
    expect(mutation.previous).toEqual(previous);
    await expect(registry.restoreImportedModelAfterFailedQueue(mutation)).resolves.toBe(true);
    await expect(registry.findImportedModel(previous.id)).resolves.toEqual(previous);
  });

  it("retains queued ownership when bridge start may have succeeded before transport failure", async () => {
    const registry = await import("@/lib/server/imported-model-registry");
    const queued = record({
      status: "queued",
      jobId: "job-response-lost",
      createdAt: "2026-08-03T00:00:00.000Z",
    });

    await expect(
      registry.withQueuedImportedModelReservation({
        record: queued,
        start: async () => {
          throw new registry.QueuedImportedModelStartUncertainError("response lost");
        },
      }),
    ).rejects.toBeInstanceOf(registry.QueuedImportedModelStartUncertainError);

    await expect(registry.findImportedModel(queued.id)).resolves.toEqual(queued);
  });

  it("releases registry and workspace admission after an accepted start loses its response", async () => {
    const registry = await import("@/lib/server/imported-model-registry");
    const gate = await import("@/lib/server/workspace-operation-gate");
    gate.resetWorkspaceOperationGateForTests();
    const queued = record({
      status: "queued",
      jobId: "job-accepted-no-response",
      createdAt: "2026-08-03T00:00:01.000Z",
    });

    await expect(
      registry.withQueuedImportedModelReservation({
        record: queued,
        start: async () => {
          throw new registry.QueuedImportedModelStartUncertainError("accepted; response timed out");
        },
      }),
    ).rejects.toBeInstanceOf(registry.QueuedImportedModelStartUncertainError);

    let exclusiveEntered = false;
    await gate.withWorkspaceExclusive("restore", async () => {
      exclusiveEntered = true;
    });
    expect(exclusiveEntered).toBe(true);
    expect(gate.getWorkspaceOperationGateStateForTests()).toMatchObject({
      exclusive: null,
      exclusivePending: false,
      sharedCount: 0,
    });
    await expect(registry.findImportedModel(queued.id)).resolves.toEqual(queued);
  });

  it("does not roll back a newer queued owner during compensation", async () => {
    const registry = await import("@/lib/server/imported-model-registry");
    const failed = await registry.queueImportedModel(record({
      status: "queued",
      jobId: "job-failed",
    }));
    const newer = record({
      status: "queued",
      jobId: "job-newer",
      createdAt: "2026-07-01T00:02:00.000Z",
    });
    await registry.queueImportedModel(newer);

    await expect(registry.restoreImportedModelAfterFailedQueue(failed)).resolves.toBe(false);
    await expect(registry.findImportedModel(newer.id)).resolves.toEqual(newer);
  });

  it("holds workspace shared admission across the registry write", async () => {
    const registry = await import("@/lib/server/imported-model-registry");
    const gate = await import("@/lib/server/workspace-operation-gate");
    gate.resetWorkspaceOperationGateForTests();
    let allowWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    registry.__importedModelRegistryTestHooks.beforeWrite = async () => {
      writeStarted();
      await new Promise<void>((resolve) => {
        allowWrite = resolve;
      });
    };
    const mutation = registry.upsertImportedModel(record());
    await started;

    let exclusiveEntered = false;
    const exclusive = gate.withWorkspaceExclusive("restore", async () => {
      exclusiveEntered = true;
    });
    await vi.waitFor(() => {
      expect(gate.getWorkspaceOperationGateStateForTests().exclusivePending).toBe(true);
    });
    expect(exclusiveEntered).toBe(false);

    allowWrite();
    await mutation;
    await exclusive;
    expect(exclusiveEntered).toBe(true);
    registry.__importedModelRegistryTestHooks.beforeWrite = null;
  });

  it("removes a temporary registry file when publication fails", async () => {
    const registry = await import("@/lib/server/imported-model-registry");
    await registry.upsertImportedModel(record());
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(
      Object.assign(new Error("publish failed"), { code: "EIO" }),
    );

    await expect(registry.upsertImportedModel(record({
      id: "imported-llama-cpp-temp-10101010",
      fileName: "temp.gguf",
    }))).rejects.toThrow("publish failed");

    expect(fs.readdirSync(modelsDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    vi.restoreAllMocks();
    await expect(registry.readImportedModels()).resolves.toEqual([
      expect.objectContaining({ id: record().id }),
    ]);
  });

  it("starts only one bridge reservation for concurrent same-id imports", async () => {
    const registry = await import("@/lib/server/imported-model-registry");
    const first = record({ status: "queued", jobId: "job-first" });
    const second = record({ status: "queued", jobId: "job-second" });
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let bridgeStarts = 0;
    const firstReservation = registry.withQueuedImportedModelReservation({
      record: first,
      start: async () => {
        bridgeStarts += 1;
        firstStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return "started";
      },
    });
    await started;
    const secondReservation = registry.withQueuedImportedModelReservation({
      record: second,
      start: async () => {
        bridgeStarts += 1;
        return "must-not-start";
      },
    });

    releaseFirst();
    await expect(firstReservation).resolves.toMatchObject({ result: "started" });
    await expect(secondReservation).rejects.toMatchObject({
      status: 409,
      code: "model_import_in_progress",
    });
    expect(bridgeStarts).toBe(1);
    await expect(registry.findImportedModel(first.id)).resolves.toEqual(first);
  });

  it("prevents delete prepared from an old record from removing a newly started job", async () => {
    const registry = await import("@/lib/server/imported-model-registry");
    const previous = record({ status: "ready", jobId: undefined });
    await registry.upsertImportedModel(previous);
    const queued = record({ status: "queued", jobId: "job-new" });
    let releaseStart!: () => void;
    let bridgeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bridgeStarted = resolve;
    });
    const reservation = registry.withQueuedImportedModelReservation({
      record: queued,
      expectedPrevious: previous,
      start: async () => {
        bridgeStarted();
        await new Promise<void>((resolve) => {
          releaseStart = resolve;
        });
        return "started";
      },
    });
    await started;
    const deletion = registry.removeImportedModelIfUnchanged(previous);

    releaseStart();
    await reservation;
    await expect(deletion).rejects.toMatchObject({
      status: 409,
      code: "model_import_in_progress",
    });
    await expect(registry.findImportedModel(queued.id)).resolves.toEqual(queued);
  });
});
