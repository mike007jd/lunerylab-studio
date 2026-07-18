import type { Asset } from "@prisma/client";
import type { AssetDTO, ContentOrigin } from "@/lib/types/api";

interface AssetJobProvenanceInput {
  origin: ContentOrigin;
  job?: {
    prompt: string;
    provider: string;
    model: string;
  } | null;
}

export function toVisibleAssetJobProvenance(asset: AssetJobProvenanceInput) {
  if (asset.origin === "TEMPLATE") {
    return { prompt: null, provider: null, model: null };
  }
  return {
    prompt: asset.job?.prompt ?? null,
    provider: asset.job?.provider ?? null,
    model: asset.job?.model ?? null,
  };
}

export function toAssetDTO(asset: Asset): AssetDTO {
  return {
    id: asset.id,
    jobId: asset.jobId,
    projectId: asset.projectId,
    kind: asset.kind as "REFERENCE" | "GENERATED",
    origin: asset.origin,
    modality: asset.modality as "IMAGE" | "VIDEO" | "MODEL_3D",
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    width: asset.width,
    height: asset.height,
    format: asset.format,
    durationSeconds: asset.durationSeconds,
    tags: asset.tags,
    isFavorite: asset.isFavorite,
    note: asset.note,
    summary: asset.summary,
    agentTaskId: asset.agentTaskId,
    parentAssetId: asset.parentAssetId,
    deletedAt: asset.deletedAt?.toISOString() ?? null,
    createdAt: asset.createdAt.toISOString(),
    url: `/api/assets/${asset.id}`,
  };
}
