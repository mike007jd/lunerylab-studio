import type { GenerateImageInput, GenerateImageResult } from "@/lib/server/generation-types";
import { generateImagesByok } from "@/lib/server/byok-image";
import { ApiError } from "@/lib/server/errors";
import { generateImagesLocal } from "@/lib/server/local-image";
import { generateImagesLocalSd } from "@/lib/server/local-sd";
import { isKnownLocalImageModelId } from "@/lib/server/local-image-model-catalog";
import { resolveImageGenerationTarget } from "@/lib/server/runtime-supply";

export type { GenerateImageResult } from "@/lib/server/generation-types";

export async function generateImages(
  input: GenerateImageInput,
): Promise<GenerateImageResult> {
  const requestedModelId = input.modelId?.trim();
  if (!requestedModelId) {
    throw new ApiError({
      status: 400,
      code: "no_model_selected",
      message:
        "No image model selected. Download a local model or connect a provider in Settings, then pick a model.",
      retryable: false,
    });
  }
  const inputWithModel = { ...input, modelId: requestedModelId };
  const target = await resolveImageGenerationTarget({
    isEdit: inputWithModel.isEdit,
    modelId: inputWithModel.modelId,
  });
  const requestedLocalImage = await isKnownLocalImageModelId(inputWithModel.modelId);

  if (target.provider === "local-sd-cpp") {
    const result = await generateImagesLocalSd(
      { ...inputWithModel, modelId: target.modelId ?? inputWithModel.modelId },
    );
    return { ...result, warnings: [...target.warnings, ...result.warnings] };
  }

  if (target.provider === "local-comfyui" && target.endpoint) {
    const result = await generateImagesLocal(
      { ...inputWithModel, modelId: target.modelId || inputWithModel.modelId },
      target.endpoint,
    );
    return { ...result, warnings: [...target.warnings, ...result.warnings] };
  }

  if (requestedLocalImage) {
    throw new ApiError({
      status: 503,
      code: "provider_error",
      message: "This local image model requires its local runtime and an installed model file.",
      retryable: true,
    });
  }

  if (target.provider === "byok" && target.providerId) {
    // BYOK path is direct fetch to the user's provider. If BYOK fails, the user
    // sees the failure with a clear error code and is sent to Settings.
    const result = await generateImagesByok(
      { ...inputWithModel, modelId: target.modelId || inputWithModel.modelId },
      target.providerId,
    );
    return { ...result, warnings: [...target.warnings, ...result.warnings] };
  }

  if (target.backend === "none") {
    throw new ApiError({
      status: 503,
      code: input.isEdit ? "image_edit_backend_missing" : "byok_not_configured",
      message: input.isEdit
        ? "Image editing requires a supported BYOK image-edit provider."
        : "No image backend is configured. Connect a BYOK provider or download a local model in Settings.",
      retryable: false,
    });
  }

  throw new ApiError({
    status: 503,
    code: input.isEdit ? "image_edit_backend_missing" : "byok_not_configured",
    message: input.isEdit
      ? "Image editing requires a supported BYOK image-edit provider."
      : "No image backend is configured. Connect a BYOK provider or download a local model in Settings.",
    retryable: false,
  });
}
