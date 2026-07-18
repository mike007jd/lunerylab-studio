import "server-only";

import { findByokProvider, type ByokProviderMeta } from "@/lib/byok-providers";
import { getByokConnectionMeta, type ByokConnectionMeta } from "@/lib/server/byok-connection-store";
import { ApiError } from "@/lib/server/errors";
import { readByokKey, requireValidatedProviderEndpoint } from "@/lib/server/byok-shared";

export interface ResolvedByokProviderConfig {
  providerId: string;
  providerMeta: ByokProviderMeta;
  connection: ByokConnectionMeta | undefined;
  apiKey: string;
  endpoint: string;
  modelId: string;
}

export async function resolveByokProviderConfig({
  providerId,
  validateProvider,
  resolveModelId,
  missingEndpointMessage,
  missingModelMessage,
}: {
  providerId: string;
  validateProvider?: (meta: ByokProviderMeta, providerId: string) => void;
  resolveModelId: (input: {
    meta: ByokProviderMeta;
    connection: ByokConnectionMeta | undefined;
  }) => string | undefined;
  missingEndpointMessage: (meta: ByokProviderMeta) => string;
  missingModelMessage: (meta: ByokProviderMeta) => string;
}): Promise<ResolvedByokProviderConfig> {
  const meta = findByokProvider(providerId);
  if (!meta) {
    throw new ApiError({
      status: 400,
      code: "byok_not_configured",
      message: `Unknown BYOK provider "${providerId}".`,
      retryable: false,
    });
  }

  validateProvider?.(meta, providerId);

  const connection = getByokConnectionMeta(providerId);
  const rawEndpoint = connection?.endpoint?.trim() || meta.defaultEndpoint;
  if (!rawEndpoint) {
    throw new ApiError({
      status: 503,
      code: "byok_not_configured",
      message: missingEndpointMessage(meta),
      retryable: false,
    });
  }

  const modelId = resolveModelId({ meta, connection })?.trim();
  if (!modelId) {
    throw new ApiError({
      status: 503,
      code: "byok_not_configured",
      message: missingModelMessage(meta),
      retryable: false,
    });
  }

  return {
    providerId,
    providerMeta: meta,
    connection,
    apiKey: await readByokKey(providerId),
    endpoint: await requireValidatedProviderEndpoint(rawEndpoint),
    modelId,
  };
}
