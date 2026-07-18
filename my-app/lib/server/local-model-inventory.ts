import { HF_MODEL_REGISTRY, type HfModelEntry } from "@/lib/hf-model-catalog";
import { readImportedModels, type ImportedModelRecord } from "@/lib/server/imported-model-registry";
import {
  catalogModelFileStatuses,
  modelFileExists,
  type LocalModelFileStatus,
} from "@/lib/server/local-model-files";

const INSTALL_STATUS_CACHE_TTL_MS = 2_000;

export interface LocalModelInstallStatus {
  id: string;
  imported: boolean;
  installed: boolean;
  partial: boolean;
  installedFiles: number;
  fileCount: number;
  installedBytes: number;
  totalBytes: number;
  missingFiles: string[];
  files: LocalModelFileStatus[];
  label?: string;
  source?: ImportedModelRecord["source"];
  runtimeTarget?: ImportedModelRecord["runtimeTarget"];
  capability?: ImportedModelRecord["capability"];
  format?: ImportedModelRecord["format"];
  fileName?: string;
  modelPath?: string;
  url?: string;
  jobId?: string;
  importStatus?: ImportedModelRecord["status"];
}

async function importedModelStatus(record: ImportedModelRecord): Promise<LocalModelInstallStatus> {
  const [complete, partial] = await Promise.all([
    modelFileExists(record.modelPath),
    modelFileExists(`${record.modelPath}.part`),
  ]);
  const installed = complete.exists;
  const partialInstall = !installed && (partial.exists || record.status === "queued");
  const bytes = installed ? complete.bytes : partial.bytes;

  return {
    id: record.id,
    label: record.label,
    imported: true,
    source: record.source,
    runtimeTarget: record.runtimeTarget,
    capability: record.capability,
    format: record.format,
    fileName: record.fileName,
    modelPath: record.modelPath,
    url: record.url,
    jobId: record.jobId,
    importStatus: record.status,
    installed,
    partial: partialInstall,
    installedFiles: installed ? 1 : 0,
    fileCount: 1,
    installedBytes: bytes,
    totalBytes: record.sizeBytes > 0 ? record.sizeBytes : bytes,
    missingFiles: installed ? [] : [record.fileName],
    files: [
      {
        fileName: record.fileName,
        installed,
        partial: partialInstall,
        bytes,
        expectedBytes: record.sizeBytes,
      },
    ],
  };
}

async function catalogModelStatus(entry: HfModelEntry): Promise<LocalModelInstallStatus> {
  const fileStatuses = await catalogModelFileStatuses(entry);

  const installedFiles = fileStatuses.filter((file) => file.installed).length;
  const partialFiles = fileStatuses.filter((file) => file.partial).length;

  const installed = fileStatuses.length > 0 && installedFiles === fileStatuses.length;

  return {
    id: entry.id,
    imported: false,
    installed,
    partial: !installed && (installedFiles > 0 || partialFiles > 0),
    installedFiles,
    fileCount: fileStatuses.length,
    installedBytes: fileStatuses.reduce((sum, file) => sum + file.bytes, 0),
    totalBytes: entry.sizeBytes,
    missingFiles: fileStatuses.filter((file) => !file.installed).map((file) => file.fileName),
    files: fileStatuses,
  };
}

let installStatusCache: { expiresAt: number; value: LocalModelInstallStatus[] } | null = null;
let installStatusInflight: Promise<LocalModelInstallStatus[]> | null = null;

async function readLocalModelInstallStatuses(): Promise<LocalModelInstallStatus[]> {
  const [catalogModels, importedModels] = await Promise.all([
    Promise.all((HF_MODEL_REGISTRY as readonly HfModelEntry[]).map(catalogModelStatus)),
    Promise.all((await readImportedModels()).map(importedModelStatus)),
  ]);

  return [...catalogModels, ...importedModels];
}

export async function listLocalModelInstallStatuses(): Promise<LocalModelInstallStatus[]> {
  const now = Date.now();
  if (installStatusCache && installStatusCache.expiresAt > now) return installStatusCache.value;
  if (installStatusInflight) return installStatusInflight;

  installStatusInflight = readLocalModelInstallStatuses()
    .then((value) => {
      installStatusCache = { expiresAt: Date.now() + INSTALL_STATUS_CACHE_TTL_MS, value };
      return value;
    })
    .finally(() => {
      installStatusInflight = null;
    });
  return installStatusInflight;
}
