"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  generationEntrySchema,
  type GenerationBatchVariant,
  type GenerationEntry,
  type GenerationEntryStatus,
  type GenerationMode,
} from "@/lib/schemas/studio-history";

export type {
  GenerationBatchVariant,
  GenerationEntry,
  GenerationEntryStatus,
  GenerationMode,
};

export interface NewEntryInput
  extends Omit<GenerationEntry, "id" | "status" | "assets" | "warnings" | "error" | "createdAt"> {
  /** Optional initial status — defaults to "running". */
  status?: GenerationEntryStatus;
}

export interface UseStudioGenerationHistoryResult {
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
  return crypto.randomUUID();
}

export const STUDIO_HISTORY_STORAGE_KEY = "lunerylab:studio-history:v2";
const STORAGE_KEY = STUDIO_HISTORY_STORAGE_KEY;
export const STUDIO_HISTORY_LIMIT = 60;

export function prependStudioHistoryEntry(
  entries: GenerationEntry[],
  entry: GenerationEntry,
): GenerationEntry[] {
  return [entry, ...entries].slice(0, STUDIO_HISTORY_LIMIT);
}

export function loadStudioHistoryEntries(raw: string | null): GenerationEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: GenerationEntry[] = [];
    for (const item of parsed) {
      const result = generationEntrySchema.safeParse(item);
      if (!result.success) continue;
      entries.push({
        ...result.data,
        status: result.data.status === "running" ? "interrupted" : result.data.status,
      });
      if (entries.length >= STUDIO_HISTORY_LIMIT) break;
    }
    return entries;
  } catch {
    return [];
  }
}

function loadInitialEntries(): GenerationEntry[] {
  if (typeof window === "undefined") return [];
  return loadStudioHistoryEntries(window.localStorage.getItem(STORAGE_KEY));
}

function persistEntries(entries: GenerationEntry[]) {
  if (typeof window === "undefined") return;
  try {
    // A page exit cannot prove the backend stopped, so restored work is
    // explicitly interrupted rather than shown as a live spinner.
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

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const initial = loadInitialEntries();
    if (initial.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEntries(initial);
    }
    setHydrated(true);
  }, []);

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
      videoDuration: input.videoDuration,
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

  return useMemo(
    () => ({ entries, hydrated, add, update, remove, find }),
    [entries, hydrated, add, update, remove, find],
  );
}
