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
