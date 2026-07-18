import { HttpError } from "@/lib/client/fetch-json";
import type { TFunction } from "@/lib/i18n/provider";
import type { ApiErrorPayload } from "@/lib/types/api";

const ACTIONABLE_ERROR_KEYS: Record<string, string> = {
  local_sd_out_of_memory: "studio.generationErrors.outOfMemory",
  local_sd_model_load_failed: "studio.generationErrors.modelLoadFailed",
  local_sd_engine_unavailable: "studio.generationErrors.engineUnavailable",
};

export function toActionableGenerationError(
  error: unknown,
  fallback: string,
  t: TFunction,
): string {
  if (!(error instanceof HttpError)) return error instanceof Error ? error.message : fallback;

  const payload = error.payload as Partial<ApiErrorPayload> | undefined;
  const code = typeof payload?.code === "string" ? payload.code : "";
  const actionKey = ACTIONABLE_ERROR_KEYS[code];
  if (actionKey) return t(actionKey);

  if (code === "local_sd_unknown") {
    const raw = typeof payload?.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : fallback;
    return `${raw} ${t("studio.generationErrors.genericGuide")}`;
  }

  return error.message || fallback;
}
