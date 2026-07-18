import "server-only";

import { BYOK_PROVIDERS, isOpenAiGptImageModel } from "@/lib/byok-providers";
import type { ImageModelEntry } from "@/lib/image-models";
import type { VideoModelEntry } from "@/lib/video-models";
import { listByokConnectionMeta } from "@/lib/server/byok-connection-store";
import { fetchConfiguredProviderIds } from "@/lib/server/byok-shared";

export async function getByokImageModels(): Promise<ImageModelEntry[]> {
  const configured = await fetchConfiguredProviderIds();
  if (configured.size === 0) return [];

  const connections = listByokConnectionMeta();
  const result: ImageModelEntry[] = [];

  for (const provider of BYOK_PROVIDERS) {
    if (!configured.has(provider.id)) continue;
    if (!provider.capabilities.includes("image")) continue;
    if (provider.imageApiMode === "none") continue;

    const meta = connections[provider.id];
    // No fallback to a static catalog default — empty stays empty. If the user
    // hasn't picked a model id in Settings, this BYOK row is simply hidden.
    const modelId = meta?.models?.imageGenerate;
    if (!modelId) continue;

    result.push({
      id: `byok:${provider.id}:${modelId}`,
      providerModelId: modelId,
      // Dead ternary — both branches were "image". The catalog only surfaces
      // image-generation rows here; multimodal entries (image-edit, etc.) get
      // emitted by the `imageEditModels` loop below with `apiMode: "image"`
      // explicitly. Keeping a tautology made it look like the catalog was
      // distinguishing modes when it wasn't.
      apiMode: "image",
      brand: provider.label,
      brandZh: provider.label,
      label: `${provider.label} · ${modelId}`,
      labelZh: `${provider.label} · ${modelId}`,
      tier: "standard",
      supportsEdit: provider.id === "openai" && isOpenAiGptImageModel(modelId),
      supportsAspectRatio: true,
      source: "byok",
      sourceEvidence: [provider.sourceEvidence],
      freshnessExpiresAt: provider.freshnessExpiresAt,
      freshnessNote: provider.placeholderModelNote,
    });

    for (const [editKind, editModelId] of Object.entries(provider.imageEditModels ?? {})) {
      if (!editModelId || editModelId === modelId) continue;
      const label = editKind === "backgroundRemove" ? "Background remove" : editKind;
      result.push({
        id: `byok:${provider.id}:${editModelId}`,
        providerModelId: editModelId,
        apiMode: "image",
        brand: provider.label,
        brandZh: provider.label,
        label: `${provider.label} · ${label}`,
        labelZh: `${provider.label} · ${label}`,
        tier: "standard",
        supportsEdit: true,
        supportsAspectRatio: true,
        source: "byok",
        sourceEvidence: [provider.sourceEvidence],
        freshnessExpiresAt: provider.freshnessExpiresAt,
        freshnessNote: `${provider.label} edit operation source: ${provider.sourceEvidence.label}.`,
      });
    }
  }

  return result;
}

export async function getByokVideoModels(): Promise<VideoModelEntry[]> {
  const configured = await fetchConfiguredProviderIds();
  if (configured.size === 0) return [];

  const connections = listByokConnectionMeta();
  const result: VideoModelEntry[] = [];

  for (const provider of BYOK_PROVIDERS) {
    if (!configured.has(provider.id)) continue;
    if (!provider.videoApiMode || provider.videoApiMode === "none") continue;

    const meta = connections[provider.id];
    // No fallback to a static catalog default — empty stays empty.
    const modelId = meta?.models?.video;
    if (!modelId) continue;

    result.push({
      id: `byok:${provider.id}:${modelId}`,
      providerModelId: modelId,
      brand: provider.label,
      brandZh: provider.label,
      label: `${provider.label} · ${modelId}`,
      labelZh: `${provider.label} · ${modelId}`,
      tier: "standard",
      // BYOK video capability is NOT verified per-model — the user can configure
      // any model id. Use a permissive working range as a default, but flag it
      // unverified so the UI presents duration / image-input as estimates rather
      // than promising 4–12s + reference for every video model (audit 6.2).
      durationMode: "range",
      durationRange: [4, 12],
      supportsImageInput: true,
      requiresImageInput: false,
      capabilityVerified: false,
      source: "byok",
      sourceEvidence: [provider.sourceEvidence],
      freshnessExpiresAt: provider.freshnessExpiresAt,
      freshnessNote: `${provider.label} video model id is user-configured; the actual duration and reference-image limits depend on your chosen model — verify against provider docs.`,
    });
  }

  return result;
}
