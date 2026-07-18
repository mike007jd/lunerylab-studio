// Provider status surface. There is no platform-funded credit pool — keys are
// BYOK and live in the OS keychain (desktop) or env (self-host). This module
// is the single read-side projection of "which providers does the current
// runtime believe are configured", merging:
//   1. byok-connection-store metadata (endpoint + modelId, no secrets) — the
//      authoritative client-facing list of "providers the user touched".
//   2. The desktop bridge `/status` snapshot, which knows whether the OS
//      keychain actually still holds a secret for each provider id.
//
// Empty results are valid — the UI renders an "add a provider" CTA in that
// case. The old stub (always {}) made the Settings card look perpetually
// unconfigured even after a working setup.

import "server-only";
import { BYOK_PROVIDERS } from "@/lib/byok-providers";
import { listByokConnectionMeta } from "@/lib/server/byok-connection-store";
import { fetchConfiguredProviderIds } from "@/lib/server/byok-shared";

export type ProviderStatus = {
  configured: boolean;
  source: "keychain" | null;
};

export async function getProviderStatus(): Promise<Record<string, ProviderStatus>> {
  const [connectionMeta, desktopProviders] = await Promise.all([
    Promise.resolve(listByokConnectionMeta()),
    fetchConfiguredProviderIds(),
  ]);

  const result: Record<string, ProviderStatus> = {};
  for (const provider of BYOK_PROVIDERS) {
    const hasConnection = Boolean(connectionMeta[provider.id]);
    const desktopConfigured = desktopProviders.has(provider.id);
    // A provider counts as "configured" only when BOTH the metadata store has
    // an entry (so we know endpoint + modelId) AND the OS keychain reports a
    // secret. Either alone is a half-state that should not unlock generation.
    const configured = hasConnection && desktopConfigured;
    if (!configured && !hasConnection && !desktopConfigured) {
      // Skip emitting an entry for providers the user has never touched —
      // keeps the response payload small for the common "fresh install" case.
      continue;
    }
    result[provider.id] = {
      configured,
      source: configured ? "keychain" : null,
    };
  }
  return result;
}
