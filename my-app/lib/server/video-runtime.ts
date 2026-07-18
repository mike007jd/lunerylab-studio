/**
 * Video runtime resolver.
 *
 * Picks the backend for a video generation:
 *   1. Any BYOK provider with `videoApiMode !== "none"` that the user has
 *      configured (fal / replicate / minimax).
 *   2. None → callers should fall back to a user-facing fix panel.
 *
 * Mirrors the local/BYOK policy used by `resolveStudioRuntimeSupply` for text
 * + image. Local video is intentionally not implemented yet — video is BYOK
 * provider work.
 */

import "server-only";
import { isVideoCapableByok } from "@/lib/byok-providers";
import { fetchConfiguredProviderIds, parseByokModelSelection } from "@/lib/server/byok-shared";

export type VideoRuntimeBackend =
  | "byok"
  | "none";

export interface VideoRuntimeTarget {
  backend: VideoRuntimeBackend;
  providerId?: string;
  modelId?: string;
  warnings: string[];
}

export async function resolveVideoRuntime(modelId?: string): Promise<VideoRuntimeTarget> {
  const warnings: string[] = [];
  const requestedByok = parseByokModelSelection(modelId);

  // BYOK first per the local-first runtime policy: no platform-funded cloud
  // relay and no static provider/model fallback.
  const configuredProviderIds = await fetchConfiguredProviderIds();
  for (const providerId of configuredProviderIds) {
    if (requestedByok && requestedByok.providerId !== providerId) continue;
    if (!isVideoCapableByok(providerId)) continue;
    // No fallback to a static default model id — empty stays empty. The
    // downstream BYOK dispatcher (generateVideoByok) reads the user's
    // connection metadata and throws `byok_not_configured` if no model was
    // chosen, surfacing a "pick a model in Settings" error instead of silently
    // routing to one the user did not pick.
    return {
      backend: "byok",
      providerId,
      modelId: requestedByok?.modelId,
      warnings,
    };
  }

  warnings.push("No video backend is configured. Connect a BYOK video provider.");
  return { backend: "none", warnings };
}
