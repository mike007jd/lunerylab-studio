import { isModel3dCapableByok } from "@/lib/byok-providers";
import type { ByokConnectionMeta } from "@/lib/server/byok-connection-store";

const MODEL_3D_PROVIDER_PRIORITY = ["meshy", "tripo", "fal", "replicate"] as const;

export function selectConfiguredModel3dProvider(
  connections: Record<string, ByokConnectionMeta>,
  configuredProviderIds: ReadonlySet<string>,
): string | null {
  for (const providerId of MODEL_3D_PROVIDER_PRIORITY) {
    if (
      connections[providerId] &&
      configuredProviderIds.has(providerId) &&
      isModel3dCapableByok(providerId)
    ) {
      return providerId;
    }
  }
  return null;
}
