import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ userSettingsUpdate: vi.fn() }));
vi.mock("@/lib/server/prisma", () => ({
  prisma: { userSettings: { update: mocks.userSettingsUpdate } },
}));

let tmpDir: string;
let modelsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-model-files-"));
  modelsDir = path.join(tmpDir, "profile", "models");
  vi.stubEnv("LUNERY_MODELS_DIR", modelsDir);
  mocks.userSettingsUpdate.mockReset();
  mocks.userSettingsUpdate.mockResolvedValue({});
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("managed local model file deletion", () => {
  it("removes cached files and partial downloads", async () => {
    const files = await import("@/lib/server/local-model-files");
    const modelPath = path.join(modelsDir, "sd-cpp", "model.safetensors");
    const partialPath = `${modelPath}.part`;
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "model");
    fs.writeFileSync(partialPath, "partial");

    await expect(files.removeManagedModelFiles([modelPath, partialPath, modelPath])).resolves.toBe(2);
    expect(fs.existsSync(modelPath)).toBe(false);
    expect(fs.existsSync(partialPath)).toBe(false);
  });

  it("rejects paths outside the profile model cache", async () => {
    const files = await import("@/lib/server/local-model-files");
    const outsidePath = path.join(tmpDir, "outside.safetensors");
    fs.writeFileSync(outsidePath, "do not delete");

    await expect(files.removeManagedModelFiles([outsidePath])).rejects.toThrow(
      "outside the managed model cache",
    );
    expect(fs.existsSync(outsidePath)).toBe(true);
  });

  it("refuses to remove a directory as a model file", async () => {
    const files = await import("@/lib/server/local-model-files");
    const directory = path.join(modelsDir, "sd-cpp", "model.safetensors");
    fs.mkdirSync(directory, { recursive: true });

    await expect(files.removeManagedModelFiles([directory])).rejects.toThrow(
      "model directory",
    );
  });

  it("stages files and can roll them back before metadata commit", async () => {
    const files = await import("@/lib/server/local-model-files");
    const modelPath = path.join(modelsDir, "sd-cpp", "model.safetensors");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "model");

    const staged = await files.stageManagedModelFiles([modelPath]);
    expect(fs.existsSync(modelPath)).toBe(false);
    expect(staged).toHaveLength(1);
    expect(fs.existsSync(staged[0]!.stagedPath)).toBe(true);

    await files.rollbackManagedModelFiles(staged);
    expect(fs.readFileSync(modelPath, "utf8")).toBe("model");
  });

  it("keeps failed post-commit cleanup staged and reconciles it on startup", async () => {
    const files = await import("@/lib/server/local-model-files");
    const modelPath = path.join(modelsDir, "llama-cpp", "model.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "model");
    const staged = await files.stageManagedModelFiles([modelPath]);
    await files.markManagedModelFilesCommitted(staged);
    files.__localModelFilesTestHooks.beforeMutation = (filePath) => {
      if (filePath.endsWith(".lunery-delete")) throw new Error("unlink failed");
    };

    await expect(files.finalizeManagedModelFiles(staged)).rejects.toMatchObject({
      name: "ManagedModelCleanupPendingError",
      removedFiles: 0,
      pendingPaths: [staged[0]!.stagedPath],
    });
    expect(fs.existsSync(staged[0]!.stagedPath)).toBe(true);

    files.__localModelFilesTestHooks.beforeMutation = null;
    await expect(files.reconcileStagedManagedModelFiles()).resolves.toBe(1);
    expect(fs.existsSync(staged[0]!.stagedPath)).toBe(false);
  });

  it("does not stage bytes when prepared-journal publication fails", async () => {
    const files = await import("@/lib/server/local-model-files");
    const native = await import("@/lib/server/native-profile-fs");
    const modelPath = path.join(modelsDir, "llama-cpp", "journal-fail.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "model");
    native.__nativeProfileFsTestHooks.execute = (request) => {
      if (request.operation === "write" && request.relative_path.includes(".managed-delete-journal")) {
        throw new Error("journal publish failed");
      }
    };

    await expect(files.stageManagedModelFiles([modelPath])).rejects.toThrow("journal publish failed");
    expect(fs.readFileSync(modelPath, "utf8")).toBe("model");
    expect(fs.readdirSync(path.dirname(modelPath))).toEqual(["journal-fail.gguf"]);
    native.__nativeProfileFsTestHooks.execute = null;
  });

  it("rolls back a prepared journal after a strong crash during staging", async () => {
    const files = await import("@/lib/server/local-model-files");
    const first = path.join(modelsDir, "llama-cpp", "first.gguf");
    const second = path.join(modelsDir, "llama-cpp", "second.gguf");
    fs.mkdirSync(path.dirname(first), { recursive: true });
    fs.writeFileSync(first, "first");
    fs.writeFileSync(second, "second");
    files.__localModelFilesTestHooks.afterStage = () => {
      throw new files.SimulatedManagedModelCrashError();
    };

    await expect(files.stageManagedModelFiles([first, second])).rejects.toBeInstanceOf(
      files.SimulatedManagedModelCrashError,
    );
    expect(fs.existsSync(first)).toBe(false);
    files.__localModelFilesTestHooks.afterStage = null;

    await expect(files.reconcileStagedManagedModelFiles()).resolves.toBe(0);
    expect(fs.readFileSync(first, "utf8")).toBe("first");
    expect(fs.readFileSync(second, "utf8")).toBe("second");
  });

  it("keeps the old prepared journal recoverable when enriched publication is interrupted", async () => {
    const files = await import("@/lib/server/local-model-files");
    const modelPath = path.join(modelsDir, "llama-cpp", "replace-crash.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "model");
    const staged = await files.stageManagedModelFiles([modelPath]);
    const journalPath = staged[0]!.journalPath!;
    files.__localModelFilesTestHooks.beforeRecoveryJournalReplace = () => {
      throw new files.SimulatedManagedModelCrashError();
    };

    await expect(files.attachManagedModelDeletionRecovery(staged, {
      ownerId: "owner-1",
      modelId: "catalog-text",
      defaults: {
        cleared: ["text"],
        previous: { defaultTextModel: "catalog-text", defaultImageModel: "" },
      },
    })).rejects.toBeInstanceOf(files.SimulatedManagedModelCrashError);

    expect(JSON.parse(fs.readFileSync(journalPath, "utf8"))).toMatchObject({
      version: 2,
      stages: [{ originalPath: modelPath }],
    });
    expect(fs.existsSync(staged[0]!.stagedPath)).toBe(true);
    files.__localModelFilesTestHooks.beforeRecoveryJournalReplace = null;

    await expect(files.reconcileStagedManagedModelFiles()).resolves.toBe(0);
    expect(fs.readFileSync(modelPath, "utf8")).toBe("model");
    expect(
      fs.readdirSync(path.dirname(journalPath)).filter((name) => name.endsWith(".replace-tmp")),
    ).toEqual([]);
  });

  it("finishes a committed journal after a post-metadata strong crash", async () => {
    const files = await import("@/lib/server/local-model-files");
    const modelPath = path.join(modelsDir, "llama-cpp", "committed.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "model");
    const staged = await files.stageManagedModelFiles([modelPath]);
    files.__localModelFilesTestHooks.afterCommittedMarker = () => {
      throw new files.SimulatedManagedModelCrashError();
    };

    await expect(files.markManagedModelFilesCommitted(staged)).rejects.toBeInstanceOf(
      files.SimulatedManagedModelCrashError,
    );
    expect(fs.existsSync(staged[0]!.stagedPath)).toBe(true);
    files.__localModelFilesTestHooks.afterCommittedMarker = null;

    await expect(files.reconcileStagedManagedModelFiles()).resolves.toBe(1);
    expect(fs.existsSync(staged[0]!.stagedPath)).toBe(false);
  });

  it("restores registry, defaults, and bytes after a crash between metadata changes and commit marker", async () => {
    const files = await import("@/lib/server/local-model-files");
    const registry = await import("@/lib/server/imported-model-registry");
    const modelPath = path.join(modelsDir, "llama-cpp", "crash-window.gguf");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "model");
    const imported = {
      id: "imported-llama-cpp-crash-window-12345678",
      label: "Crash window",
      source: "huggingface-url" as const,
      runtimeTarget: "llama-cpp" as const,
      capability: "planner-llm" as const,
      format: "gguf" as const,
      fileName: "crash-window.gguf",
      modelPath,
      sizeBytes: 5,
      sha256: "a".repeat(64),
      status: "ready" as const,
      createdAt: "2026-08-03T00:00:00.000Z",
      url: "https://huggingface.co/org/model/resolve/main/crash-window.gguf",
    };
    await registry.upsertImportedModel(imported);
    const staged = await files.stageManagedModelFiles([modelPath]);
    await files.attachManagedModelDeletionRecovery(staged, {
      ownerId: "owner-1",
      modelId: imported.id,
      importedModel: imported,
      defaults: {
        cleared: ["text"],
        previous: { defaultTextModel: `local:${imported.id}`, defaultImageModel: "" },
      },
    });

    await registry.removeImportedModel(imported.id);
    expect(await registry.findImportedModel(imported.id)).toBeUndefined();
    expect(fs.existsSync(modelPath)).toBe(false);

    await expect(files.reconcileStagedManagedModelFiles()).resolves.toBe(0);
    expect(await registry.findImportedModel(imported.id)).toEqual(imported);
    expect(fs.readFileSync(modelPath, "utf8")).toBe("model");
    expect(mocks.userSettingsUpdate).toHaveBeenCalledWith({
      where: { userId: "owner-1" },
      data: { defaultTextModel: `local:${imported.id}` },
    });
  });

  it("restores an external model across managed and external crash journals in startup order", async () => {
    const files = await import("@/lib/server/local-model-files");
    const registry = await import("@/lib/server/imported-model-registry");
    const modelPath = path.join(tmpDir, "external", "cross-journal.gguf");
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "external-model");
    const resolved = await registry.resolveLocalModelPath(modelPath);
    if ("error" in resolved) throw new Error(resolved.error);
    const imported = {
      id: "imported-llama-cpp-cross-journal-12345678",
      label: "Cross journal",
      source: "local-path" as const,
      runtimeTarget: "llama-cpp" as const,
      capability: "planner-llm" as const,
      format: "gguf" as const,
      fileName: path.basename(modelPath),
      modelPath,
      sizeBytes: resolved.sizeBytes,
      fileIdentity: resolved.fileIdentity,
      sha256: null,
      status: "ready" as const,
      createdAt: "2026-08-03T00:00:00.000Z",
    };
    const settings = {
      defaultTextModel: `local:${imported.id}`,
      defaultImageModel: "",
    };
    mocks.userSettingsUpdate.mockImplementation(async (operation: {
      data: Partial<typeof settings>;
    }) => {
      Object.assign(settings, operation.data);
      return settings;
    });
    await registry.upsertImportedModel(imported);
    const stagedExternal = await registry.stageImportedExternalModelFile(imported);
    const stagedManaged = await files.stageManagedModelFiles([]);
    await files.attachManagedModelDeletionRecovery(stagedManaged, {
      ownerId: "owner-1",
      modelId: imported.id,
      importedModel: imported,
      defaults: {
        cleared: ["text"],
        previous: { ...settings },
      },
    });

    settings.defaultTextModel = "";
    await registry.removeImportedModel(imported.id);
    const managedJournalDir = path.join(modelsDir, ".managed-delete-journal");
    const managedJournalEntries = fs.readdirSync(managedJournalDir);
    expect(fs.existsSync(modelPath)).toBe(false);
    expect(fs.existsSync(stagedExternal.stagedPath)).toBe(true);
    expect(await registry.findImportedModel(imported.id)).toBeUndefined();
    expect(settings.defaultTextModel).toBe("");
    expect(managedJournalEntries.filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(managedJournalEntries.some((name) => name.endsWith(".committed"))).toBe(false);

    await files.reconcileStagedManagedModelFiles();
    await registry.reconcileExternalModelDeleteJournals();

    expect(fs.readFileSync(modelPath, "utf8")).toBe("external-model");
    expect(await registry.findImportedModel(imported.id)).toEqual(imported);
    expect(settings).toEqual({
      defaultTextModel: `local:${imported.id}`,
      defaultImageModel: "",
    });
    expect(fs.existsSync(stagedExternal.stagedPath)).toBe(false);
    expect(fs.existsSync(stagedExternal.journalPath)).toBe(false);
    expect(
      fs.readdirSync(managedJournalDir)
        .filter((name) => name.endsWith(".json")),
    ).toEqual([]);
  });

  it("keeps bytes staged until crash metadata restoration succeeds", async () => {
    const files = await import("@/lib/server/local-model-files");
    const modelPath = path.join(modelsDir, "sd-cpp", "retry-recovery.safetensors");
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "model");
    const staged = await files.stageManagedModelFiles([modelPath]);
    await files.attachManagedModelDeletionRecovery(staged, {
      ownerId: "owner-1",
      modelId: "catalog-image",
      defaults: {
        cleared: ["image"],
        previous: { defaultTextModel: "", defaultImageModel: "catalog-image" },
      },
    });
    mocks.userSettingsUpdate.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(files.reconcileStagedManagedModelFiles()).rejects.toThrow("database unavailable");
    expect(fs.existsSync(modelPath)).toBe(false);
    expect(fs.existsSync(staged[0]!.stagedPath)).toBe(true);

    mocks.userSettingsUpdate.mockResolvedValue({});
    await expect(files.reconcileStagedManagedModelFiles()).resolves.toBe(0);
    expect(fs.readFileSync(modelPath, "utf8")).toBe("model");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a deterministic cache-directory swap before staging",
    async () => {
      const files = await import("@/lib/server/local-model-files");
      const runtimeDir = path.join(modelsDir, "sd-cpp");
      const heldDir = `${runtimeDir}.held`;
      const modelPath = path.join(runtimeDir, "model.safetensors");
      const outside = path.join(tmpDir, "outside");
      const outsideModel = path.join(outside, "model.safetensors");
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(modelPath, "inside");
      fs.writeFileSync(outsideModel, "outside");
      let swapped = false;
      files.__localModelFilesTestHooks.beforeMutation = () => {
        if (swapped) return;
        swapped = true;
        fs.renameSync(runtimeDir, heldDir);
        fs.symlinkSync(outside, runtimeDir, "dir");
      };

      try {
        await expect(files.removeManagedModelFiles([modelPath])).rejects.toThrow(
          /symlink|outside the managed model cache|changed during deletion/,
        );
        expect(fs.readFileSync(outsideModel, "utf8")).toBe("outside");
      } finally {
        files.__localModelFilesTestHooks.beforeMutation = null;
        fs.unlinkSync(runtimeDir);
        fs.renameSync(heldDir, runtimeDir);
      }
    },
  );
});
