import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModelCapability, ModelFormat, ModelRuntimeTarget } from "@/lib/hf-model-catalog";
import { luneryModelsDir } from "@/lib/server/lunery-profile";

export type ImportedModelSource = "local-path" | "huggingface-url";
export type ImportedModelStatus = "ready" | "queued";

export interface ImportedModelRecord {
  id: string;
  label: string;
  source: ImportedModelSource;
  runtimeTarget: ModelRuntimeTarget;
  capability: ModelCapability;
  format: ModelFormat;
  fileName: string;
  modelPath: string;
  sizeBytes: number;
  sha256: string | null;
  status: ImportedModelStatus;
  createdAt: string;
  url?: string;
  jobId?: string;
}

const IMPORTABLE_EXTENSIONS = new Set([".gguf", ".safetensors", ".bin"]);

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

export function modelsCacheRoot(): string {
  return luneryModelsDir();
}

export function modelCacheCandidatePaths(runtimeTarget: ModelRuntimeTarget, fileName: string): string[] {
  return [path.join(modelsCacheRoot(), runtimeTarget, fileName)];
}

/** Canonical on-disk path for a model file: `<modelsRoot>/<runtimeTarget>/<fileName>`. */
export function modelCachePath(runtimeTarget: ModelRuntimeTarget, fileName: string): string {
  return modelCacheCandidatePaths(runtimeTarget, fileName)[0]!;
}

export function importedModelsRegistryPath(): string {
  return path.join(modelsCacheRoot(), "imported-models.json");
}

export function importedModelDownloadDest(runtimeTarget: ModelRuntimeTarget, modelId: string, fileName: string): string {
  return path.join(modelsCacheRoot(), runtimeTarget, "imported", modelId, fileName);
}

export function normalizeImportableRuntimeTarget(value: string | null | undefined): ModelRuntimeTarget | null {
  const allowed = new Set<ModelRuntimeTarget>(["llama-cpp", "sd-cpp", "ollama", "lm-studio", "comfyui"]);
  return value && allowed.has(value as ModelRuntimeTarget) ? (value as ModelRuntimeTarget) : null;
}

export function safeImportableFileName(value: string): string | null {
  const name = path.basename(value.trim());
  const ext = path.extname(name).toLowerCase();
  if (!name || name === "." || name === "..") return null;
  if (!IMPORTABLE_EXTENSIONS.has(ext)) return null;
  return name;
}

export function inferImportedModelFormat(fileName: string): ModelFormat {
  return path.extname(fileName).toLowerCase() === ".gguf" ? "gguf" : "diffusers";
}

export function inferImportedModelCapability(runtimeTarget: ModelRuntimeTarget, fileName: string): ModelCapability {
  if (runtimeTarget === "sd-cpp" || runtimeTarget === "comfyui") return "image-gen";
  if (runtimeTarget === "ollama" && fileName.toLowerCase().includes("vision")) return "vision";
  return "planner-llm";
}

export function validateImportedRuntimeFormat(
  runtimeTarget: ModelRuntimeTarget,
  fileName: string,
): { capability: ModelCapability; format: ModelFormat } | { error: string } {
  const ext = path.extname(fileName).toLowerCase();
  if (runtimeTarget === "llama-cpp" || runtimeTarget === "ollama" || runtimeTarget === "lm-studio") {
    if (ext !== ".gguf") {
      return { error: `${runtimeTarget} imports require a GGUF model file.` };
    }
    return { capability: inferImportedModelCapability(runtimeTarget, fileName), format: "gguf" };
  }
  if (runtimeTarget === "sd-cpp") {
    if (ext !== ".gguf" && ext !== ".safetensors") {
      return { error: "stable-diffusion.cpp imports require a GGUF or safetensors model file." };
    }
    return { capability: "image-gen", format: inferImportedModelFormat(fileName) };
  }
  if (runtimeTarget === "comfyui") {
    if (ext !== ".safetensors") {
      return { error: "ComfyUI imports require a safetensors model file." };
    }
    return { capability: "image-gen", format: "diffusers" };
  }
  return { error: "Unsupported runtime target." };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

export function importedModelId(runtimeTarget: ModelRuntimeTarget, fileName: string, sourceKey = fileName): string {
  const stem = path.basename(fileName, path.extname(fileName));
  const digest = createHash("sha1").update(sourceKey).digest("hex").slice(0, 8);
  return `imported-${runtimeTarget}-${slugify(stem) || "model"}-${digest}`;
}

export async function readImportedModels(): Promise<ImportedModelRecord[]> {
  const current = await readImportedModelsFrom(importedModelsRegistryPath());
  if (current) return current;
  return [];
}

async function readImportedModelsFrom(registryPath: string): Promise<ImportedModelRecord[] | null> {
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isImportedModelRecord) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return [];
  }
}

export async function findImportedModel(id: string): Promise<ImportedModelRecord | undefined> {
  const records = await readImportedModels();
  return records.find((record) => record.id === id);
}

export async function upsertImportedModel(record: ImportedModelRecord): Promise<ImportedModelRecord> {
  const records = await readImportedModels();
  const next = records.filter((item) => item.id !== record.id);
  next.push(record);
  next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  await writeImportedModels(next);
  return record;
}

async function writeImportedModels(records: ImportedModelRecord[]): Promise<void> {
  const registryPath = importedModelsRegistryPath();
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(records, null, 2), "utf8");
  await fs.rename(tmpPath, registryPath);
}

export async function resolveLocalModelPath(input: string): Promise<{
  modelPath: string;
  fileName: string;
  sizeBytes: number;
} | {
  error: string;
}> {
  const trimmed = input.trim();
  if (!trimmed) return { error: "Paste an absolute path to a local model file." };
  const expanded = trimmed.startsWith("~/") ? path.join(homeDir(), trimmed.slice(2)) : trimmed;
  if (!path.isAbsolute(expanded)) return { error: "Use an absolute local model path." };

  const fileName = safeImportableFileName(expanded);
  if (!fileName) return { error: "Use a .gguf, .safetensors, or .bin model file." };

  try {
    const stat = await fs.stat(expanded);
    if (!stat.isFile()) return { error: "The model path must point to a file." };
    return { modelPath: path.resolve(expanded), fileName, sizeBytes: stat.size };
  } catch {
    return { error: "The model file does not exist." };
  }
}

function isImportedModelRecord(value: unknown): value is ImportedModelRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ImportedModelRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.modelPath === "string" &&
    typeof record.fileName === "string" &&
    typeof record.runtimeTarget === "string" &&
    typeof record.capability === "string" &&
    typeof record.format === "string" &&
    typeof record.sizeBytes === "number"
  );
}
