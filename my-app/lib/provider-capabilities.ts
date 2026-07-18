import type { ByokProviderMeta } from "@/lib/byok-providers";

export interface ProviderCapabilityCopy {
  capabilityText: string;
  capabilityImage: string;
  capabilityVideo: string;
  capability3d: string;
}

export function formatProviderCapabilities(
  meta: ByokProviderMeta,
  copy: ProviderCapabilityCopy,
): string {
  const capabilities = [
    meta.capabilities.includes("text") ? copy.capabilityText : null,
    meta.capabilities.includes("image") && meta.imageApiMode !== "none"
      ? copy.capabilityImage
      : null,
    meta.capabilities.includes("video") ? copy.capabilityVideo : null,
    meta.capabilities.includes("model-3d") ? copy.capability3d : null,
  ].filter((value): value is string => Boolean(value));

  return capabilities.join(" / ");
}
