import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("server-only", () => ({}));

let tmpDir: string;
let modelsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-model-files-"));
  modelsDir = path.join(tmpDir, "profile", "models");
  vi.stubEnv("LUNERY_MODELS_DIR", modelsDir);
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
