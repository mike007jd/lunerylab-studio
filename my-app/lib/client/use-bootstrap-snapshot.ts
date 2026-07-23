"use client";

import { useEffect, useRef, useState } from "react";
import type { ByokConnectionModels } from "@/lib/byok-providers";

export const BOOTSTRAP_INVALIDATION_EVENT = "lunerylab:bootstrap-invalidated";

export function invalidateBootstrapSnapshot(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(BOOTSTRAP_INVALIDATION_EVENT));
  }
}
export interface ProviderSnapshot {
  configured: boolean;
  /**
   * Where the credential is sourced from: "keychain" when the desktop runtime
   * resolved a secret via the OS keychain (the BYOK path), or null when not
   * configured.
   */
  source: "keychain" | null;
}

export interface BootstrapUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface BootstrapSnapshot {
  user: BootstrapUser | null;
  app: {
    defaultLocale: string;
    defaultTextModel: string;
    defaultImageModel: string;
    defaultVideoModel: string;
  };
  providers: Record<string, ProviderSnapshot>;
  providerConnections: Record<
    string,
    {
      endpoint: string;
      models?: ByokConnectionModels;
      updatedAt: string;
    }
  >;
}

export async function fetchBootstrapSnapshot(): Promise<BootstrapSnapshot | null> {
  try {
    const response = await fetch("/api/bootstrap", { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as BootstrapSnapshot;
  } catch {
    return null;
  }
}

interface UseBootstrapSnapshotOptions {
  intervalMs?: number;
  refreshKey?: string;
  initialData?: BootstrapSnapshot | null;
  disabled?: boolean;
}

export function snapshotsDiffer(a: BootstrapSnapshot | null, b: BootstrapSnapshot): boolean {
  if (!a) return true;
  if (a.app.defaultLocale !== b.app.defaultLocale) return true;
  if (a.app.defaultTextModel !== b.app.defaultTextModel) return true;
  if (a.app.defaultImageModel !== b.app.defaultImageModel) return true;
  if (a.app.defaultVideoModel !== b.app.defaultVideoModel) return true;
  if (a.user?.id !== b.user?.id) return true;
  const prevProviderKeys = Object.keys(a.providers);
  const nextProviderKeys = Object.keys(b.providers);
  if (prevProviderKeys.length !== nextProviderKeys.length) return true;
  for (const key of nextProviderKeys) {
    const prev = a.providers[key];
    const next = b.providers[key];
    if (!prev || !next || prev.configured !== next.configured || prev.source !== next.source) {
      return true;
    }
  }
  const prevConnectionKeys = Object.keys(a.providerConnections);
  const nextConnectionKeys = Object.keys(b.providerConnections);
  if (prevConnectionKeys.length !== nextConnectionKeys.length) return true;
  for (const key of nextConnectionKeys) {
    const prev = a.providerConnections[key];
    const next = b.providerConnections[key];
    if (
      !prev ||
      !next ||
      prev.endpoint !== next.endpoint ||
      prev.updatedAt !== next.updatedAt ||
      JSON.stringify(prev.models ?? {}) !== JSON.stringify(next.models ?? {})
    ) {
      return true;
    }
  }
  return false;
}

export function useBootstrapSnapshot(options: UseBootstrapSnapshotOptions = {}) {
  const { intervalMs = 8_000, refreshKey, initialData, disabled = false } = options;
  const [snapshot, setSnapshot] = useState<BootstrapSnapshot | null>(initialData ?? null);
  // Bootstrap polls every few seconds but rarely changes. Compare the fields
  // subscribers actually read so we don't notify the canvas on every poll.
  const lastSnapshotRef = useRef<BootstrapSnapshot | null>(initialData ?? null);

  useEffect(() => {
    if (disabled || intervalMs <= 0) {
      return;
    }

    // Fresh SSR data can arrive via initialData on navigation; keep the diff
    // baseline in sync so the next poll compares against it, not a stale seed.
    if (initialData) lastSnapshotRef.current = initialData;

    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const sync = async () => {
      const payload = await fetchBootstrapSnapshot();
      if (!active || !payload) return;
      if (!snapshotsDiffer(lastSnapshotRef.current, payload)) return;
      lastSnapshotRef.current = payload;
      setSnapshot(payload);
    };

    const scheduleNext = () => {
      timer = setTimeout(async () => {
        await sync();
        if (active && !document.hidden) {
          scheduleNext();
        }
      }, intervalMs);
    };

    const startPolling = (skipInitialSync = false) => {
      if (timer) return;
      if (!skipInitialSync) void sync();
      scheduleNext();
    };

    const stopPolling = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        startPolling();
      }
    };

    startPolling(!!initialData);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener(BOOTSTRAP_INVALIDATION_EVENT, sync);

    return () => {
      active = false;
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener(BOOTSTRAP_INVALIDATION_EVENT, sync);
    };
  }, [disabled, initialData, intervalMs, refreshKey]);

  return snapshot;
}
