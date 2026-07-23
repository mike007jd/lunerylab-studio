/**
 * Runtime Supply Module
 *
 * Owns the Studio runtime decision: local embedded engines first, BYOK second,
 * optional cloud fallback last, and a structured fix when no backend can serve the task.
 *
 * This is the deep module behind the old capability-router compatibility
 * interface. Callers should prefer the Runtime Supply interface so endpoint,
 * model, provider, fallback, and missing-capability rules stay local here.
 */

import { isDesktopRuntime } from "@/lib/desktop-runtime";
import {
  isKnownLocalImageModelId,
  resolveInstalledSdCppImageModel,
  type LocalImageRuntimeAvailability,
} from "@/lib/server/local-image-model-catalog";
import type {
  AgentBackendKind,
  CapabilityFixCapability,
  CapabilityFixPanel,
} from "@/lib/types/api";
import { findByokProvider, type ByokModelRole } from "@/lib/byok-providers";
import { listByokConnectionMeta } from "@/lib/server/byok-connection-store";
import {
  fetchConfiguredProviderIds,
  fetchDesktopStatusSnapshot,
  isByokModelSelectionId,
  parseByokModelSelection,
} from "@/lib/server/byok-shared";

export type RuntimeSupplyCapability = "text" | "image";

export interface RuntimeSupplyFix {
  capability: CapabilityFixCapability;
  panel: CapabilityFixPanel;
  reason: string;
}

export interface RuntimeSupplyTarget {
  capability: RuntimeSupplyCapability;
  backend: AgentBackendKind;
  localRuntime?: "sd-cpp" | "comfyui" | "openai-compatible";
  endpoint?: string;
  modelId?: string;
  providerId?: string;
  warnings: string[];
  fix?: RuntimeSupplyFix;
}

export interface RuntimeSupplyByokCandidate {
  providerId: string;
  modelId?: string;
}

export interface StudioRuntimeSupply {
  text: RuntimeSupplyTarget;
  image: RuntimeSupplyTarget;
  generationBackend: AgentBackendKind;
  imageBackend: AgentBackendKind;
  backendUsed: { llm: string; image: string };
  capabilityFix?: RuntimeSupplyFix;
}

export interface ImageGenerationTarget {
  backend: AgentBackendKind;
  provider: "local-sd-cpp" | "local-comfyui" | "byok";
  providerId?: string;
  endpoint?: string;
  modelId?: string;
  warnings: string[];
}

const PROBE_CACHE_TTL_MS = 30_000;

interface RuntimeProbeResult {
  endpoint: string;
  reachable: boolean;
  models: string[];
  latency_ms: number;
}

interface CachedEndpointProbe {
  result: RuntimeProbeResult | null;
  expiresAt: number;
}

const endpointProbeCache = new Map<string, CachedEndpointProbe>();
const pendingEndpointProbes = new Map<string, Promise<RuntimeProbeResult | null>>();

export async function discoverLocalRuntimeModels(endpoint: string): Promise<string[]> {
  const base = endpoint.replace(/\/+$/, "");
  const [ollamaResult, openaiResult] = await Promise.allSettled([
    fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1000), cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return [] as string[];
        const data: unknown = await response.json();
        if (!data || typeof data !== "object" || !("models" in data)) return [] as string[];
        const models = (data as { models: unknown }).models;
        if (!Array.isArray(models)) return [] as string[];
        return models
          .map((model) =>
            model && typeof model === "object" && "name" in model && typeof model.name === "string"
              ? model.name.trim()
              : "",
          )
          .filter(Boolean);
      })
      .catch(() => [] as string[]),
    fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(1000), cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return [] as string[];
        const data: unknown = await response.json();
        if (!data || typeof data !== "object" || !("data" in data)) return [] as string[];
        const models = (data as { data: unknown }).data;
        if (!Array.isArray(models)) return [] as string[];
        return models
          .map((model) =>
            model && typeof model === "object" && "id" in model && typeof model.id === "string"
              ? model.id.trim()
              : "",
          )
          .filter(Boolean);
      })
      .catch(() => [] as string[]),
  ]);

  const ollamaModels = ollamaResult.status === "fulfilled" ? ollamaResult.value : [];
  if (ollamaModels.length > 0) return ollamaModels;
  return openaiResult.status === "fulfilled" ? openaiResult.value : [];
}

async function probeEndpoint(endpoint: string): Promise<RuntimeProbeResult | null> {
  const now = Date.now();
  const cached = endpointProbeCache.get(endpoint);
  if (cached && cached.expiresAt > now) return cached.result;

  const inFlight = pendingEndpointProbes.get(endpoint);
  if (inFlight) return inFlight;

  const probe = (async () => {
    try {
      const bridgeUrl = process.env.LUNERY_DESKTOP_BRIDGE_URL;
      const bridgeToken = process.env.LUNERY_DESKTOP_BRIDGE_TOKEN;
      if (!bridgeUrl || !bridgeToken) {
        endpointProbeCache.set(endpoint, { result: null, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
        return null;
      }

      const response = await fetch(`${bridgeUrl}/runtime-probe`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-lunery-desktop-token": bridgeToken,
        },
        body: JSON.stringify({ endpoint }),
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) {
        endpointProbeCache.set(endpoint, { result: null, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
        return null;
      }
      const bridgeResult = (await response.json()) as Omit<RuntimeProbeResult, "models">;
      const result: RuntimeProbeResult = {
        ...bridgeResult,
        endpoint,
        models: bridgeResult.reachable ? await discoverLocalRuntimeModels(endpoint) : [],
      };
      endpointProbeCache.set(endpoint, { result, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
      return result;
    } catch {
      endpointProbeCache.set(endpoint, { result: null, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
      return null;
    } finally {
      pendingEndpointProbes.delete(endpoint);
    }
  })();

  pendingEndpointProbes.set(endpoint, probe);
  return probe;
}

const DEFAULT_LOCAL_TEXT_ENDPOINTS = [
  "http://127.0.0.1:11434",
  "http://127.0.0.1:1234",
];

/**
 * Normalize a runtime model id for exact comparison. Runtimes report ids in
 * slightly different shapes (Ollama appends `:latest`, casing varies), so we
 * canonicalize before matching. This is a normalization, NOT a fuzzy match —
 * two different models never collide.
 */
function normalizeRuntimeModelId(value: string): string {
  return value.trim().toLowerCase().replace(/:latest$/, "");
}

function runtimeModelMatches(candidate: string, selected: string): boolean {
  return normalizeRuntimeModelId(candidate) === normalizeRuntimeModelId(selected);
}

export async function resolveLocalImageRuntimeAvailability(): Promise<LocalImageRuntimeAvailability> {
  if (!isDesktopRuntime()) return { sdCpp: false, comfyUi: false };

  const status = await fetchDesktopStatusSnapshot();
  if (!status) return { sdCpp: false, comfyUi: false };

  const sdCpp = status.local_runtimes.some(
    (runtime) => runtime.id === "sd-cpp" && runtime.status === "ready",
  );
  const comfyUiProbe = await probeEndpoint("http://127.0.0.1:8188").catch(() => null);
  return { sdCpp, comfyUi: Boolean(comfyUiProbe?.reachable) };
}

async function tryResolveLocal(
  capability: RuntimeSupplyCapability,
  modelId?: string,
): Promise<RuntimeSupplyTarget | null> {
  if (!isDesktopRuntime()) return null;
  const explicitLocalModel = modelId?.startsWith("local:") ? modelId.slice("local:".length) : modelId;

  const status = await fetchDesktopStatusSnapshot();
  if (!status) return null;

  let endpointsToProbe: string[];
  if (capability === "image") {
    const requestedLocalImageModel = await isKnownLocalImageModelId(explicitLocalModel);

    const embeddedSd = status.local_runtimes.find(
      (runtime) => runtime.id === "sd-cpp" && runtime.status === "ready",
    );
    const installedSdModel = embeddedSd ? await resolveInstalledSdCppImageModel(explicitLocalModel) : null;
    if (embeddedSd && installedSdModel) {
      return {
        capability,
        backend: "local",
        localRuntime: "sd-cpp",
        modelId: installedSdModel.id,
        warnings: [],
      };
    }
    if (explicitLocalModel && !requestedLocalImageModel) return null;
    endpointsToProbe = ["http://127.0.0.1:8188"];
  } else {
    const llama = status.local_runtimes.find(
      (runtime) => runtime.id === "llama-cpp" && runtime.status === "ready" && /^https?:\/\//.test(runtime.endpoint),
    );
    endpointsToProbe = [
      ...(llama ? [llama.endpoint] : []),
      ...DEFAULT_LOCAL_TEXT_ENDPOINTS,
    ];
  }

  const endpointProbes = await Promise.all(
    endpointsToProbe.map(async (endpoint) => ({
      endpoint,
      probe: await probeEndpoint(endpoint).catch(() => null),
    })),
  );

  if (capability === "image") {
    // ComfyUI checkpoint selection is resolved downstream in
    // resolveImageGenerationTarget (which carries the user's requested modelId
    // into the workflow). Here we only need the first reachable image endpoint.
    for (const { endpoint, probe } of endpointProbes) {
      if (!probe?.reachable) continue;
      return {
        capability,
        backend: "local",
        localRuntime: "comfyui",
        endpoint,
        modelId: probe.models[0] ?? undefined,
        warnings: [],
      };
    }
    return null;
  }

  // Text: the user selected a specific local model. NO DEFAULT MODEL — only an
  // endpoint that actually hosts that exact model may serve it. We must never
  // fall back to "first model on the first reachable endpoint", which could run
  // a model the user did not choose (e.g. Ollama + LM Studio both online).
  let reachableWithoutModels = false;
  let reachableWithoutSelectedModel = false;

  for (const { endpoint, probe } of endpointProbes) {
    if (!probe?.reachable) continue;
    if (probe.models.length === 0) {
      reachableWithoutModels = true;
      continue;
    }
    if (!explicitLocalModel) {
      // resolveTextRuntimeSupply guarantees a selection; defend against callers
      // that reach here without one rather than guessing a model.
      reachableWithoutSelectedModel = true;
      continue;
    }
    const matched = probe.models.find((model) => runtimeModelMatches(model, explicitLocalModel));
    if (matched) {
      return {
        capability,
        backend: "local",
        localRuntime: "openai-compatible",
        endpoint,
        // Return the runtime's own id string for the matched model so the
        // downstream request targets exactly what the runtime loaded.
        modelId: matched,
        warnings: [],
      };
    }
    reachableWithoutSelectedModel = true;
  }

  if (reachableWithoutSelectedModel && explicitLocalModel) {
    return {
      capability,
      backend: "none",
      warnings: [`Selected model "${explicitLocalModel}" is not loaded in any local runtime.`],
      fix: {
        capability: "text",
        panel: "local_models",
        reason: `Selected model "${explicitLocalModel}" is not loaded`,
      },
    };
  }

  if (reachableWithoutModels) {
    return {
      capability,
      backend: "none",
      warnings: ["Local runtime reachable but no models are loaded."],
      fix: { capability: "text", panel: "local_models", reason: "No models loaded in local runtime" },
    };
  }

  return null;
}

export async function resolveRuntimeByokCandidates(
  capability: RuntimeSupplyCapability,
  modelId?: string,
): Promise<RuntimeSupplyByokCandidate[]> {
  if (!isDesktopRuntime()) return [];

  const configuredProviderIds = await fetchConfiguredProviderIds();
  if (configuredProviderIds.size === 0) return [];

  const configuredProviders = [...configuredProviderIds]
    .map((providerId) => findByokProvider(providerId))
    .filter((provider): provider is NonNullable<typeof provider> => {
      if (!provider) return false;
      if (capability === "image") return provider.imageApiMode !== "none";
      return provider.capabilities.includes("text");
    });
  if (configuredProviders.length === 0) return [];

  const connectionMeta = listByokConnectionMeta();
  const requestedModel = modelId?.trim();
  const requestedByok = parseByokModelSelection(requestedModel);
  // Each capability resolves only its own slot (image → imageGenerate, text →
  // text); a model configured for one capability never satisfies another.
  const role: ByokModelRole = capability === "image" ? "imageGenerate" : "text";

  if (requestedByok) {
    const configured = configuredProviders.find((provider) => provider.id === requestedByok.providerId);
    return configured ? [{ providerId: configured.id, modelId: requestedByok.modelId }] : [];
  }

  if (requestedModel) {
    // Match only against actual user-configured connection modelIds. The old
    // catalog-default fallbacks were removed per the no-default-model rule —
    // an arbitrary catalog string should never satisfy a user's pick.
    const configured = configuredProviders.find(
      (provider) => connectionMeta[provider.id]?.models?.[role] === requestedModel,
    );
    return configured ? [{ providerId: configured.id, modelId: requestedModel }] : [];
  }

  // No explicit model requested: a provider is a candidate only if it actually
  // has a model in this capability's slot — never "any first configured
  // provider". Carry the resolved slot id so the planner uses the user's pick.
  return configuredProviders.flatMap((provider) => {
    const slotModelId = connectionMeta[provider.id]?.models?.[role];
    return slotModelId ? [{ providerId: provider.id, modelId: slotModelId }] : [];
  });
}

async function tryResolveByok(
  capability: RuntimeSupplyCapability,
  modelId?: string,
): Promise<RuntimeSupplyTarget | null> {
  const [configured] = await resolveRuntimeByokCandidates(capability, modelId);
  if (!configured) return null;

  return {
    capability,
    backend: "byok",
    providerId: configured.providerId,
    modelId: configured.modelId,
    warnings: [],
  };
}

async function resolveRuntimeSupplyTarget(
  capability: RuntimeSupplyCapability,
  noBackendFix: RuntimeSupplyFix,
  noBackendWarning: string,
  modelId?: string,
): Promise<RuntimeSupplyTarget> {
  let localFixHint: RuntimeSupplyFix | undefined;
  const requestedByok = isByokModelSelectionId(modelId);

  if (requestedByok) {
    const byok = await tryResolveByok(capability, modelId).catch(() => null);
    if (byok) return byok;
  }

  // Log (don't silently swallow) a local-resolution error so a transient local
  // probe failure that pushes the request down to BYOK is observable.
  const local = requestedByok
    ? null
    : await tryResolveLocal(capability, modelId).catch((err) => {
        console.error(`[runtime-supply] local resolve failed for ${capability}:`, err);
        return null;
      });
  if (local?.backend === "local") return local;
  if (local?.backend === "none" && local.fix) localFixHint = local.fix;

  const byok = requestedByok ? null : await tryResolveByok(capability, modelId).catch(() => null);
  if (byok) return byok;

  return {
    capability,
    backend: "none",
    warnings: [noBackendWarning],
    fix: localFixHint ?? noBackendFix,
  };
}

export async function resolveTextRuntimeSupply(modelId?: string): Promise<RuntimeSupplyTarget> {
  if (!modelId?.trim()) {
    return {
      capability: "text",
      backend: "none",
      warnings: ["No text model is selected."],
      fix: { capability: "text", panel: "provider_connections", reason: "Select a text model in Settings" },
    };
  }
  return resolveRuntimeSupplyTarget(
    "text",
    isDesktopRuntime()
      ? { capability: "text", panel: "provider_connections", reason: "No text AI configured and no local text runtime available" }
      : { capability: "text", panel: "provider_connections", reason: "No text AI configured" },
    "No LLM backend is configured.",
    modelId,
  );
}

async function resolveImageRuntimeSupplyForModel(modelId?: string): Promise<RuntimeSupplyTarget> {
  return resolveRuntimeSupplyTarget(
    "image",
    isDesktopRuntime()
      ? { capability: "image", panel: "local_models", reason: "No local image model downloaded and no image AI configured" }
      : { capability: "image", panel: "provider_connections", reason: "No image AI configured" },
    "No image backend is configured.",
    modelId,
  );
}

export async function resolveStudioRuntimeSupply({
  textModelId,
  imageModelId,
}: { textModelId?: string; imageModelId?: string } = {}): Promise<StudioRuntimeSupply> {
  const [text, image] = await Promise.all([
    resolveTextRuntimeSupply(textModelId),
    resolveImageRuntimeSupplyForModel(imageModelId),
  ]);

  return {
    text,
    image,
    generationBackend: text.backend,
    imageBackend: image.backend,
    backendUsed: {
      llm: text.modelId ?? text.providerId ?? text.backend,
      image: image.modelId ?? image.providerId ?? image.backend,
    },
    capabilityFix: text.fix ?? image.fix,
  };
}

export async function resolveImageGenerationTarget({
  isEdit,
  modelId,
}: {
  isEdit?: boolean;
  modelId?: string;
}): Promise<ImageGenerationTarget> {
  const supply = await resolveImageRuntimeSupplyForModel(modelId);
  const warnings = [...supply.warnings];

  if (isEdit) {
    if (supply.backend === "byok" && supply.providerId) {
      return {
        backend: "byok",
        provider: "byok",
        providerId: supply.providerId,
        modelId: supply.modelId ?? modelId,
        warnings,
      };
    }

    return {
      backend: "none",
      provider: "byok",
      modelId,
      warnings: [
        ...warnings,
        "Image editing requires a supported BYOK image-edit provider.",
      ],
    };
  }

  if (supply.backend === "local" && !isEdit) {
    if (supply.localRuntime === "sd-cpp") {
      return {
        backend: "local",
        provider: "local-sd-cpp",
        modelId: supply.modelId,
        warnings,
      };
    }

    if (supply.localRuntime === "comfyui" && supply.endpoint) {
      return {
        backend: "local",
        provider: "local-comfyui",
        endpoint: supply.endpoint,
        modelId,
        warnings,
      };
    }
  }

  if (supply.backend === "byok" && supply.providerId) {
    return {
      backend: "byok",
      provider: "byok",
      providerId: supply.providerId,
      modelId: supply.modelId ?? modelId,
      warnings,
    };
  }

  return {
    backend: "none",
    provider: "byok",
    modelId,
    warnings,
  };
}
