"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ImageModelEntry } from "@/lib/image-models";
import type { VideoModelEntry } from "@/lib/video-models";

interface ImageBySourceCounts {
  local: number;
  byok: number;
  cloud: number;
}

interface ModelsResponse {
  imageModels?: ImageModelEntry[];
  videoModels?: VideoModelEntry[];
  defaultImageModelId?: string;
  source?: "local";
  counts?: {
    image: number;
    video: number;
    imageBySource?: ImageBySourceCounts;
  };
}

const FALLBACK_IMAGE_BY_SOURCE: ImageBySourceCounts = { local: 0, byok: 0, cloud: 0 };

interface CatalogSnapshot {
  payload: ModelsResponse | null;
  loading: boolean;
  error: boolean;
}

// ---------------------------------------------------------------------------
// Module-level shared store. Every consumer (composer, capability banner,
// settings, canvas gating) reads the SAME /api/models snapshot, so capability
// conclusions can never disagree between surfaces. Revalidation is
// stale-while-revalidate: `loading` is only true before the first payload —
// background refreshes swap data in place without flashing skeletons.
// ---------------------------------------------------------------------------

// Collapses bursts (several components mounting on one navigation, focus +
// visibility firing together) into a single fetch.
const REVALIDATE_MIN_INTERVAL_MS = 5_000;

let snapshot: CatalogSnapshot = { payload: null, loading: true, error: false };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let lastFetchAt = 0;
// Raw response body of the last successful fetch — when a revalidation returns
// byte-identical JSON we skip the snapshot swap entirely, so window refocus
// doesn't re-render every catalog consumer for nothing.
let lastBody: string | null = null;

function setSnapshot(next: CatalogSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function fetchCatalog(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await fetch("/api/models", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Model catalog failed: ${response.status}`);
      const body = await response.text();
      if (body !== lastBody || snapshot.loading || snapshot.error) {
        const json = JSON.parse(body) as ModelsResponse;
        lastBody = body;
        setSnapshot({ payload: json, loading: false, error: false });
      }
    } catch {
      // On a failed revalidation keep the last good payload — stale models
      // beat flipping a working composer into an error state. Only surface
      // `error` when we never got a payload at all.
      const nextError = snapshot.payload === null;
      if (snapshot.loading || snapshot.error !== nextError) {
        setSnapshot({ payload: snapshot.payload, loading: false, error: nextError });
      }
    } finally {
      lastFetchAt = Date.now();
      inflight = null;
    }
  })();
  return inflight;
}

// Safe to call from event listeners — the event argument is ignored.
function revalidate() {
  if (lastFetchAt && Date.now() - lastFetchAt < REVALIDATE_MIN_INTERVAL_MS) return;
  void fetchCatalog();
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible") revalidate();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  };
}

const SERVER_SNAPSHOT: CatalogSnapshot = { payload: null, loading: true, error: false };

export function useModelCatalog() {
  const snap = useSyncExternalStore(subscribe, () => snapshot, () => SERVER_SNAPSHOT);

  // Mount-time revalidation preserves the old per-component freshness (each
  // page used to refetch on mount); the min-interval gate dedupes bursts.
  useEffect(() => {
    revalidate();
  }, []);

  return useMemo(
    () => {
      const imageModels = snap.payload?.imageModels ?? [];
      const rawCounts = snap.payload?.counts;
      return {
        imageModels,
        videoModels: snap.payload?.videoModels ?? [],
        // Empty when nothing is configured — there is no hardcoded fallback
        // model. UI treats "" as "no model selected; pick or connect one".
        defaultImageModelId: snap.payload?.defaultImageModelId || "",
        source: snap.payload?.source ?? "local",
        counts: {
          image: rawCounts?.image ?? 0,
          video: rawCounts?.video ?? 0,
          imageBySource: rawCounts?.imageBySource ?? FALLBACK_IMAGE_BY_SOURCE,
        },
        loading: snap.loading,
        error: snap.error,
      };
    },
    [snap],
  );
}

export function resolveSelectableImageModelId(
  models: ImageModelEntry[],
  requestedId: string | undefined,
  fallbackId: string,
): string {
  if (requestedId && models.some((model) => model.id === requestedId)) return requestedId;
  if (fallbackId && models.some((model) => model.id === fallbackId)) return fallbackId;
  if (models.length === 1) {
    const [onlyAvailableModel] = models;
    return onlyAvailableModel?.id ?? "";
  }
  return "";
}

export function resolveSelectableVideoModelId(
  models: VideoModelEntry[],
  requestedId: string | undefined,
  { hasReferenceImage = true }: { hasReferenceImage?: boolean } = {},
): string {
  const canUse = (model: VideoModelEntry) => hasReferenceImage || !model.requiresImageInput;
  if (requestedId && models.some((model) => model.id === requestedId && canUse(model))) return requestedId;
  return "";
}
