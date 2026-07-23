import {
  findByokProvider,
  type ByokConnectionModels,
  type ByokProviderMeta,
} from "@/lib/byok-providers";
import type {
  DesktopBridgePhase,
  DesktopInvoke,
  ProviderConnectionStatus,
  SavedProviderConnection,
} from "./types";

export function desktopBridgeDisabledReason(
  phase: DesktopBridgePhase,
  copy: { checking: string; unavailable: string },
): string | undefined {
  if (phase === "loading") return copy.checking;
  if (phase === "unavailable") return copy.unavailable;
  return undefined;
}

export function providerSecretSourceLabel(
  runtime: Pick<ProviderConnectionStatus, "keychain_status" | "source"> | undefined,
  statusAvailable: boolean,
  savedSecret: boolean,
  copy: {
    env: string;
    keychain: string;
    keychainUnavailable: string;
    saved: string;
    notConnected: string;
  },
): string {
  if (runtime?.source === "environment") return copy.env;
  if (runtime?.keychain_status === "unavailable") return copy.keychainUnavailable;
  if (runtime?.source === "system-keychain") return copy.keychain;
  if (!statusAvailable && savedSecret) return copy.saved;
  return copy.notConnected;
}
/** Draft model map for the editor, seeded from a saved connection. */
export function draftModelsFromConnection(
  saved: SavedProviderConnection | undefined,
): ByokConnectionModels {
  return { ...(saved?.models ?? {}) };
}

export function shouldOpenProviderAdvancedSettings(
  meta: Pick<ByokProviderMeta, "requiresEndpoint" | "requiresModelId">,
): boolean {
  return meta.requiresEndpoint || meta.requiresModelId;
}

interface ProviderRequestToken {
  providerId: string;
  revision: number;
}

export function createProviderRequestGate() {
  let revision = 0;

  return {
    begin(providerId: string): ProviderRequestToken {
      revision += 1;
      return { providerId, revision };
    },
    invalidate(): void {
      revision += 1;
    },
    isCurrent(token: ProviderRequestToken, activeProviderId: string): boolean {
      return token.providerId === activeProviderId && token.revision === revision;
    },
  };
}

export async function runProviderSaveSingleFlight<T>(
  lock: { current: boolean },
  save: () => Promise<T>,
): Promise<{ started: false } | { started: true; value: T }> {
  if (lock.current) return { started: false };

  lock.current = true;
  try {
    return { started: true, value: await save() };
  } finally {
    lock.current = false;
  }
}

export async function bridgeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (command === "desktop_runtime_status") {
    const response = await fetch("/api/desktop-runtime/status", { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text());
    const payload = (await response.json().catch(() => null)) as
      | ({ available?: boolean; error?: string } & T)
      | null;
    if (!payload || payload.available === false) {
      throw new Error(payload?.error ?? "Desktop runtime bridge is not available");
    }
    return payload;
  }

  if (command === "save_provider_secret") {
    const response = await fetch("/api/desktop-runtime/provider-secret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args?.payload ?? {}),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<T>;
  }

  if (command === "delete_provider_secret") {
    const response = await fetch("/api/desktop-runtime/provider-secret", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args?.payload ?? {}),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<T>;
  }

  throw new Error(`Unsupported desktop command: ${command}`);
}

export async function saveProviderConnectionTransaction<T>({
  providerId,
  apiKey,
  hadSecret,
  invoke,
  saveConnection,
}: {
  providerId: string;
  apiKey: string;
  hadSecret: boolean;
  invoke: DesktopInvoke;
  saveConnection: () => Promise<T>;
}): Promise<
  | { status: "saved"; connection: T }
  | { status: "failed" }
  | { status: "partial" }
> {
  const nextKey = apiKey.trim();
  if (nextKey) {
    try {
      await invoke("save_provider_secret", {
        payload: { providerId, apiKey: nextKey },
      });
    } catch {
      return { status: "failed" };
    }
  }

  try {
    return { status: "saved", connection: await saveConnection() };
  } catch {
    if (!nextKey) return { status: "failed" };

    // A replacement key cannot be rolled back because secrets are intentionally
    // write-only. Keep it and tell the user that only the key was saved.
    if (hadSecret) return { status: "partial" };

    try {
      await invoke("delete_provider_secret", { payload: { providerId } });
      return { status: "failed" };
    } catch {
      return { status: "partial" };
    }
  }
}

export async function removeProviderCredentials({
  providerId,
  invoke,
  fetcher = fetch,
}: {
  providerId: string;
  invoke: DesktopInvoke | null;
  fetcher?: typeof fetch;
}): Promise<{ ok: true } | { ok: false; secretRemoved: boolean }> {
  if (!invoke) {
    return { ok: false, secretRemoved: false };
  }

  // Metadata is the canonical record that lets the app find a keychain secret.
  // Delete it only after the secret endpoint confirms deletion; otherwise a
  // bridge outage would strand an undiscoverable keychain entry.
  try {
    await invoke("delete_provider_secret", { payload: { providerId } });
  } catch {
    return { ok: false, secretRemoved: false };
  }

  try {
    const response = await fetcher("/api/desktop-runtime/provider-connections", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId }),
    });
    return response.ok ? { ok: true } : { ok: false, secretRemoved: true };
  } catch {
    return { ok: false, secretRemoved: true };
  }
}

export function providerMeta(id: string): ByokProviderMeta {
  return (
    findByokProvider(id) ?? {
      id,
      label: id,
      defaultEndpoint: "",
      capabilities: ["text"],
      requiresEndpoint: false,
      requiresModelId: true,
      sourceEvidence: {
        label: "Unknown provider metadata",
        url: "",
        lastVerifiedAt: "2026-06-02",
      },
      freshnessExpiresAt: "2026-07-02",
      imageApiMode: "none",
    }
  );
}
