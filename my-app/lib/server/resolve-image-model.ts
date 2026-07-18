import "server-only";

import type { ImageModelEntry } from "@/lib/image-models";
import { ApiError } from "@/lib/server/errors";
import { resolveImageModelEntry } from "@/lib/server/model-catalog";

async function resolveRequestedModel(modelId: string): Promise<ImageModelEntry | undefined> {
  return resolveImageModelEntry(modelId);
}

export async function resolveImageModelForGeneration({
  modelId,
  requiresEdit,
}: {
  modelId?: string;
  requiresEdit: boolean;
}): Promise<{ model: ImageModelEntry; warnings: string[] }> {
  // No hardcoded fallback: an empty model id means the user has not picked or
  // connected a model. Surface that instead of silently substituting one.
  const requestedId = modelId?.trim();
  if (!requestedId) {
    throw new ApiError({
      status: 400,
      code: "no_model_selected",
      message:
        "No image model selected. Download a local model or connect a provider in Settings, then pick a model.",
      retryable: false,
    });
  }
  const requestedModel = await resolveRequestedModel(requestedId);
  if (!requestedModel) {
    throw new ApiError({
      status: 400,
      code: "invalid_model",
      message: `Unknown image model: ${requestedId}`,
      retryable: false,
    });
  }

  if (!requiresEdit) {
    return { model: requestedModel, warnings: [] };
  }

  if (requestedModel.supportsEdit && requestedModel.source === "byok") {
    return { model: requestedModel, warnings: [] };
  }

  throw new ApiError({
    status: 400,
    code: "model_edit_unsupported",
    message: `Selected model ${requestedModel.label} does not support reference images. Pick an image-edit-capable model in Settings.`,
    retryable: false,
  });
}
