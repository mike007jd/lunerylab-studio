"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetDTO } from "@/lib/types/api";
import type { GenerationParameters } from "@/lib/generation-parameters";

// Lightweight in-page history survives refreshes; Library remains canonical.
// Running entries are not persisted because they cannot survive the page lifecycle.

export type GenerationEntryStatus =
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "canceled"
  /**
   * The page was left (or the app closed) while this entry was still
   * running. The request itself keeps going server-side — finished assets
   * land in Library — so on rehydrate we show a "check Library / retry"
   * card instead of silently dropping the entry or resurrecting a ghost
   * spinner.
   */
  | "interrupted";

export type GenerationMode = "image" | "video";

export interface GenerationBatchVariant {
  key: string;
  label: string;
  promptSuffix: string;
}

/**
 * A single generation request initiated from Studio. For images this maps 1:1
 * to a POST /api/generate/images call (which may itself produce N assets). For
 * videos this maps to a single video job whose final asset (if any) lands in
 * `assets[0]`.
 */
export interface GenerationEntry {
  id: string;
  mode: GenerationMode;
  status: GenerationEntryStatus;
  prompt: string;
  /** Snapshot of params at submit time so retry rebuilds the exact request. */
  modelId: string;
  aspectRatio: string;
  count: number;
  presetId: string | null;
  projectId: string | null;
  referenceAssetIds: string[];
  batchVariants: GenerationBatchVariant[] | null;
  generationParameters: GenerationParameters;
  /** Resolved assets returned by the API on success. */
  assets: AssetDTO[];
  /** Warning strings from the active backend (model fallback etc.). */
  warnings: string[];
  /** Human-readable failure message on failed status. */
  error: string | null;
  createdAt: number;
}

interface NewEntryInput
  extends Omit<GenerationEntry, "id" | "status" | "assets" | "warnings" | "error" | "createdAt"> {
  /** Optional initial status — defaults to "running". */
  status?: GenerationEntryStatus;
}

interface UseStudioGenerationHistoryResult {
  entries: GenerationEntry[];
  /** True after browser-local history has been read and the final layout is known. */
  hydrated: boolean;
  /** Adds a new "running" entry to the front of the list and returns its id. */
  add: (input: NewEntryInput) => string;
  /** Patches an existing entry; no-op if id is unknown. */
  update: (id: string, patch: Partial<GenerationEntry>) => void;
  /** Removes one entry — used when user dismisses a failed card. */
  remove: (id: string) => void;
  /** Lookup helper exposed because the parent page builds retries by id. */
  find: (id: string) => GenerationEntry | null;
}

function nextId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const STORAGE_KEY = "luna:studio-history:v1";
export const STUDIO_HISTORY_LIMIT = 60;

export function prependStudioHistoryEntry(
  entries: GenerationEntry[],
  entry: GenerationEntry,
): GenerationEntry[] {
  return [entry, ...entries].slice(0, STUDIO_HISTORY_LIMIT);
}

function loadInitialEntries(): GenerationEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter out any persisted `running` entries — those would resurrect as
    // ghost spinners after a refresh. Cap length defensively.
    return parsed
      .filter((e): e is GenerationEntry => !!e && typeof e === "object" && e.status !== "running")
      .map((entry) => ({
        ...entry,
        generationParameters: entry.generationParameters ?? {},
      }))
      .slice(0, STUDIO_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function persistEntries(entries: GenerationEntry[]) {
  if (typeof window === "undefined") return;
  try {
    // `running` entries are persisted as `interrupted`: if the page lifecycle
    // ends before the request resolves, the next session shows a clear
    // "this kept going — check Library or retry" card instead of either a
    // ghost spinner or a silently vanished generation.
    const trimmed = entries
      .map((e) => (e.status === "running" ? { ...e, status: "interrupted" as const } : e))
      .slice(0, STUDIO_HISTORY_LIMIT);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage may be unavailable (Safari private mode, quota); silently
    // degrade to session-only history rather than crash the page.
  }
}

export function useStudioGenerationHistory(): UseStudioGenerationHistoryResult {
  const [entries, setEntries] = useState<GenerationEntry[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const hydratedRef = useRef(false);

  // Hydrate once on mount — done in an effect (not useState initializer) so
  // server render and first client render match, avoiding hydration warnings.
  // The setEntries-in-effect rule is intentionally bypassed here: this is the
  // canonical "hydrate from localStorage post-mount" pattern; without it we'd
  // either ship an SSR/CSR mismatch or move history out of this hook entirely.
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const initial = loadInitialEntries();
    if (initial.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEntries(initial);
    }
    // Keep this in the same effect as the history read so consumers reveal the
    // Studio only after its centered/results layout has reached the final state.
    setHydrated(true);
  }, []);

  // Persist on every change — cheap because entries is small (capped to
  // STUDIO_HISTORY_LIMIT) and the write is debounced naturally by React
  // batching. Running entries are filtered inside persistEntries.
  useEffect(() => {
    if (!hydratedRef.current) return;
    persistEntries(entries);
  }, [entries]);

  const add = useCallback((input: NewEntryInput) => {
    const id = nextId();
    const entry: GenerationEntry = {
      id,
      mode: input.mode,
      status: input.status ?? "running",
      prompt: input.prompt,
      modelId: input.modelId,
      aspectRatio: input.aspectRatio,
      count: input.count,
      presetId: input.presetId,
      projectId: input.projectId,
      referenceAssetIds: input.referenceAssetIds,
      batchVariants: input.batchVariants,
      generationParameters: input.generationParameters,
      assets: [],
      warnings: [],
      error: null,
      createdAt: Date.now(),
    };
    setEntries((prev) => prependStudioHistoryEntry(prev, entry));
    return id;
  }, []);

  const update = useCallback((id: string, patch: Partial<GenerationEntry>) => {
    setEntries((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }, []);

  const remove = useCallback((id: string) => {
    setEntries((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const find = useCallback(
    (id: string) => entries.find((entry) => entry.id === id) ?? null,
    [entries],
  );

  // Memoise the returned API object so it keeps a stable identity across
  // renders that don't touch `entries` (e.g. every keystroke in the composer).
  // add/update/remove are already stable; without this the fresh object literal
  // re-ran the consumer's video-sync effect and reallocated its generation
  // handlers on every keystroke.
  return useMemo(
    () => ({ entries, hydrated, add, update, remove, find }),
    [entries, hydrated, add, update, remove, find],
  );
}
