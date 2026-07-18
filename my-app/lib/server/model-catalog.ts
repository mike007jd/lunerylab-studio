import "server-only";

import { NO_DEFAULT_IMAGE_MODEL_ID, type ImageModelEntry } from "@/lib/image-models";
import type { VideoModelEntry } from "@/lib/video-models";
import { getLocalImageModels, resolveLocalImageModelEntry } from "@/lib/server/local-image-model-catalog";
import { getByokImageModels, getByokVideoModels } from "@/lib/server/byok-image-catalog";
import { parseByokModelSelection } from "@/lib/server/byok-shared";
import { resolveLocalImageRuntimeAvailability } from "@/lib/server/runtime-supply";

export interface ModelCatalog {
  imageModels: ImageModelEntry[];
  videoModels: VideoModelEntry[];
  defaultImageModelId: string;
  source: "local";
  fetchedAt: string;
  counts: {
    image: number;
    video: number;
    imageBySource: { local: number; byok: number; cloud: number };
  };
}

export async function getModelCatalog(): Promise<ModelCatalog> {
  const [runtimeAvailability, byokModels, videoModels] = await Promise.all([
    resolveLocalImageRuntimeAvailability(),
    getByokImageModels(),
    getByokVideoModels(),
  ]);
  const localModels = await getLocalImageModels(runtimeAvailability);

  const seen = new Set<string>();
  const imageModels: ImageModelEntry[] = [];
  for (const model of [...localModels, ...byokModels]) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    imageModels.push(model);
  }

  const localCount = imageModels.filter((m) => m.source === "local").length;
  const byokCount = imageModels.filter((m) => m.source === "byok").length;

  return {
    imageModels,
    videoModels,
    defaultImageModelId: NO_DEFAULT_IMAGE_MODEL_ID,
    source: "local",
    fetchedAt: new Date().toISOString(),
    counts: {
      image: imageModels.length,
      video: videoModels.length,
      imageBySource: { local: localCount, byok: byokCount, cloud: 0 },
    },
  };
}

export async function resolveImageModelEntry(modelId: string): Promise<ImageModelEntry | undefined> {
  if (parseByokModelSelection(modelId)) {
    const byokModels = await getByokImageModels();
    return byokModels.find((model) => model.id === modelId || model.providerModelId === modelId);
  }

  const runtimeAvailability = await resolveLocalImageRuntimeAvailability();
  const local = await resolveLocalImageModelEntry(modelId, runtimeAvailability);
  if (local) return local;
  const byokModels = await getByokImageModels();
  return byokModels.find((model) => model.id === modelId || model.providerModelId === modelId);
}

export async function resolveVideoModelEntry(modelId: string): Promise<VideoModelEntry | undefined> {
  const byokModels = await getByokVideoModels();
  return byokModels.find((model) => model.id === modelId || model.providerModelId === modelId);
}
