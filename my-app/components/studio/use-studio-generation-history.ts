"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
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
  /**
   * Always true for session-only history — there is no async storage hydrate.
   * Kept so Studio surfaces can keep a stable readiness gate.
   */
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

export const STUDIO_HISTORY_LIMIT = 60;

export function prependStudioHistoryEntry(
  entries: GenerationEntry[],
  entry: GenerationEntry,
): GenerationEntry[] {
  return [entry, ...entries].slice(0, STUDIO_HISTORY_LIMIT);
}

const StudioGenerationHistoryContext =
  createContext<UseStudioGenerationHistoryResult | null>(null);

/**
 * Console-shell owner for session-only Studio history. Survives Studio route
 * unmount/remount for the lifetime of the WebView session, without durable
 * WebView storage or profile backup.
 */
export function StudioGenerationHistoryProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<GenerationEntry[]>([]);

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

  const value = useMemo(
    () => ({ entries, hydrated: true as const, add, update, remove, find }),
    [entries, add, update, remove, find],
  );

  return createElement(StudioGenerationHistoryContext.Provider, { value }, children);
}

/**
 * Session-only Studio generation history owned by the console shell provider.
 * Durable assets belong in Library / profile-backed storage — this list resets
 * when the WebView session ends.
 */
export function useStudioGenerationHistory(): UseStudioGenerationHistoryResult {
  const value = useContext(StudioGenerationHistoryContext);
  if (!value) {
    throw new Error("useStudioGenerationHistory must be used within StudioGenerationHistoryProvider.");
  }
  return value;
}
