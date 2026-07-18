import "server-only";

import type { ImageModelEntry } from "@/lib/image-models";
import { HF_MODEL_REGISTRY, type HfModelEntry } from "@/lib/hf-model-catalog";
import { readImportedModels, type ImportedModelRecord } from "@/lib/server/imported-model-registry";
import { catalogModelInstalled, modelFileExists } from "@/lib/server/local-model-files";

export interface LocalImageRuntimeAvailability {
  sdCpp: boolean;
  comfyUi: boolean;
}

function isRunnableSdCppImageEntry(entry: HfModelEntry | undefined): entry is HfModelEntry {
  return Boolean(
    entry &&
      entry.capability === "image-gen" &&
      entry.runtimeTarget === "sd-cpp" &&
      entry.lifecycleStatus !== "planned" &&
      entry.fileName,
  );
}

function findRegistryEntry(modelId: string): HfModelEntry | undefined {
  return (HF_MODEL_REGISTRY as readonly HfModelEntry[]).find((entry) => entry.id === modelId);
}

export async function isKnownLocalImageModelId(modelId?: string): Promise<boolean> {
  if (!modelId) return false;
  const catalog = findRegistryEntry(modelId);
  if (catalog?.capability === "image-gen") return catalog.lifecycleStatus !== "planned";
  if (modelId.startsWith("imported-sd-cpp-") || modelId.startsWith("imported-comfyui-")) {
    return true;
  }
  const records = await readImportedModels();
  return records.some((record) => record.id === modelId && record.capability === "image-gen");
}

export async function resolveInstalledSdCppImageModel(
  modelId?: string,
): Promise<{ id: string } | null> {
  if (modelId) {
    const catalogEntry = findRegistryEntry(modelId);
    if (isRunnableSdCppImageEntry(catalogEntry)) {
      return (await catalogModelInstalled(catalogEntry)) ? { id: catalogEntry.id } : null;
    }

    const requestedImport = (await readImportedModels()).find((record) => record.id === modelId);
    if (
      requestedImport?.capability !== "image-gen" ||
      requestedImport.runtimeTarget !== "sd-cpp"
    ) {
      return null;
    }
    return (await modelFileExists(requestedImport.modelPath)).exists ? { id: modelId } : null;
  }

  const records = await readImportedModels();
  const installedImports = (
    await Promise.all(
      records
        .filter(
          (record) =>
            record.capability === "image-gen" &&
            record.runtimeTarget === "sd-cpp",
        )
        .map(async (record) => ({ record, installed: (await modelFileExists(record.modelPath)).exists })),
    )
  )
    .filter((item) => item.installed)
    .map((item) => item.record);

  const imported = installedImports[0];
  if (imported) return { id: imported.id };

  const catalogIds = (HF_MODEL_REGISTRY as readonly HfModelEntry[])
    .filter(isRunnableSdCppImageEntry)
    .map((entry) => entry.id);
  for (const id of catalogIds) {
    const catalogEntry = findRegistryEntry(id);
    if (catalogEntry && (await catalogModelInstalled(catalogEntry))) return { id };
  }
  return null;
}

function localTierFor(entry: HfModelEntry): ImageModelEntry["tier"] {
  if (entry.speedTier === "fast") return "fast";
  if (entry.speedTier === "quality") return "premium";
  return "standard";
}

function catalogImageModelEntry(entry: HfModelEntry): ImageModelEntry {
  return {
    id: entry.id,
    providerModelId: entry.id,
    apiMode: "image",
    brand: "Local",
    brandZh: "本地",
    label: entry.label,
    labelZh: entry.label,
    tier: localTierFor(entry),
    supportsEdit: false,
    supportsAspectRatio: true,
    source: "local",
    sourceEvidence: [...entry.sourceEvidence],
    freshnessExpiresAt: entry.freshnessExpiresAt,
    freshnessNote: entry.freshnessNote,
  };
}

function importedImageModelEntry(record: ImportedModelRecord): ImageModelEntry {
  return {
    id: record.id,
    providerModelId: record.id,
    apiMode: "image",
    brand: "Local",
    brandZh: "本地",
    label: record.label,
    labelZh: record.label,
    tier: "fast",
    supportsEdit: false,
    supportsAspectRatio: true,
    source: "local",
    sourceEvidence: [
      {
        label: record.source === "huggingface-url" ? "User-imported Hugging Face model" : "User-imported local file",
        url: record.url ?? "https://huggingface.co/models",
        lastVerifiedAt: record.createdAt.slice(0, 10),
      },
    ],
    freshnessExpiresAt: new Date(Date.parse(record.createdAt) + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    freshnessNote:
      "Imported model metadata is user-provided and not recommended by default; refresh the upstream source before treating it as current.",
  };
}

export async function getInstalledCatalogImageModels(
  availability: LocalImageRuntimeAvailability,
): Promise<ImageModelEntry[]> {
  if (!availability.sdCpp) return [];
  const entries = (HF_MODEL_REGISTRY as readonly HfModelEntry[]).filter(
    isRunnableSdCppImageEntry,
  );
  const installed = await Promise.all(
    entries.map(async (entry) => ({ entry, ready: await catalogModelInstalled(entry) })),
  );

  return installed
    .filter((item) => item.ready)
    .map(({ entry }) => catalogImageModelEntry(entry));
}

export async function getImportedImageModels(
  availability: LocalImageRuntimeAvailability,
): Promise<ImageModelEntry[]> {
  const records = await readImportedModels();
  const installed = await Promise.all(
    records
      .filter(
        (record) =>
          record.capability === "image-gen" &&
          ((record.runtimeTarget === "sd-cpp" && availability.sdCpp) ||
            (record.runtimeTarget === "comfyui" && availability.comfyUi)),
      )
      .map(async (record) => ({ record, ready: (await modelFileExists(record.modelPath)).exists })),
  );

  return installed
    .filter((item) => item.ready)
    .map(({ record }) => importedImageModelEntry(record));
}

export async function getLocalImageModels(
  availability: LocalImageRuntimeAvailability,
): Promise<ImageModelEntry[]> {
  const [catalog, imported] = await Promise.all([
    getInstalledCatalogImageModels(availability),
    getImportedImageModels(availability),
  ]);
  return [...catalog, ...imported];
}

export async function resolveLocalImageModelEntry(
  modelId: string,
  availability: LocalImageRuntimeAvailability,
): Promise<ImageModelEntry | undefined> {
  const catalogEntry = findRegistryEntry(modelId);
  if (
    availability.sdCpp &&
    isRunnableSdCppImageEntry(catalogEntry) &&
    (await catalogModelInstalled(catalogEntry))
  ) {
    return catalogImageModelEntry(catalogEntry);
  }

  const imported = (await readImportedModels()).find((record) => record.id === modelId);
  if (
    imported?.capability !== "image-gen" ||
    (imported.runtimeTarget !== "sd-cpp" && imported.runtimeTarget !== "comfyui") ||
    (imported.runtimeTarget === "sd-cpp" && !availability.sdCpp) ||
    (imported.runtimeTarget === "comfyui" && !availability.comfyUi) ||
    !(await modelFileExists(imported.modelPath)).exists
  ) {
    return undefined;
  }
  return importedImageModelEntry(imported);
}
