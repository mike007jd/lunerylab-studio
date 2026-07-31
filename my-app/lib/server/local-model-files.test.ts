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
});
