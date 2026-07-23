"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetDTO } from "@/lib/types/api";
import type { GenerationParameters } from "@/lib/generation-parameters";

// Lightweight in-page history survives refreshes; Library remains canonical.
// Running entries are persisted as interrupted because they cannot keep a live
// spinner across the page lifecycle.

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

/** Current Lunery Studio history key. Legacy `luna:studio-history:v1` is ignored. */
export const STUDIO_HISTORY_STORAGE_KEY = "lunerylab:studio-history";
const STORAGE_KEY = STUDIO_HISTORY_STORAGE_KEY;
export const STUDIO_HISTORY_LIMIT = 60;

const ENTRY_STATUSES = new Set<GenerationEntryStatus>([
  "running",
  "succeeded",
  "partial",
  "failed",
  "canceled",
  "interrupted",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseGenerationParameters(value: unknown): GenerationParameters | null {
  if (!isPlainObject(value)) return null;
  const parameters: GenerationParameters = {};
  if (value.seed !== undefined) {
    if (!Number.isInteger(value.seed)) return null;
    parameters.seed = value.seed as number;
  }
  if (value.steps !== undefined) {
    if (!Number.isInteger(value.steps)) return null;
    parameters.steps = value.steps as number;
  }
  if (value.cfg !== undefined) {
    if (typeof value.cfg !== "number" || !Number.isFinite(value.cfg)) return null;
    parameters.cfg = value.cfg;
  }
  if (value.negativePrompt !== undefined) {
    if (typeof value.negativePrompt !== "string") return null;
    if (value.negativePrompt) parameters.negativePrompt = value.negativePrompt;
  }
  return parameters;
}

function parseBatchVariants(value: unknown): GenerationBatchVariant[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return null;
  const variants: GenerationBatchVariant[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) return null;
    if (typeof item.key !== "string" || typeof item.label !== "string" || typeof item.promptSuffix !== "string") {
      return null;
    }
    variants.push({
      key: item.key,
      label: item.label,
      promptSuffix: item.promptSuffix,
    });
  }
  return variants;
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isAssetDTO(value: unknown): value is AssetDTO {
  if (!isPlainObject(value)) return false;

  for (const field of ["id", "jobId", "mimeType", "createdAt", "url"] as const) {
    if (typeof value[field] !== "string") return false;
  }
  for (const field of [
    "projectId",
    "format",
    "note",
    "summary",
    "agentTaskId",
    "parentAssetId",
    "deletedAt",
  ] as const) {
    if (!isStringOrNull(value[field])) return false;
  }
  if (value.kind !== "REFERENCE" && value.kind !== "GENERATED") return false;
  if (value.origin !== "USER" && value.origin !== "TEMPLATE") return false;
  if (value.modality !== "IMAGE" && value.modality !== "VIDEO" && value.modality !== "MODEL_3D") {
    return false;
  }
  if (typeof value.byteSize !== "number" || !Number.isFinite(value.byteSize)) return false;
  if (!isFiniteNumberOrNull(value.width)) return false;
  if (!isFiniteNumberOrNull(value.height)) return false;
  if (!isFiniteNumberOrNull(value.durationSeconds)) return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) {
    return false;
  }
  if (typeof value.isFavorite !== "boolean") return false;

  for (const field of ["generationSeed", "generationSteps", "generationCfg"] as const) {
    if (value[field] !== undefined && !isFiniteNumberOrNull(value[field])) return false;
  }
  for (const field of ["negativePrompt", "generationModel"] as const) {
    if (value[field] !== undefined && !isStringOrNull(value[field])) return false;
  }
  return true;
}

function parseHistoryEntry(value: unknown): GenerationEntry | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (value.mode !== "image" && value.mode !== "video") return null;
  if (typeof value.status !== "string" || !ENTRY_STATUSES.has(value.status as GenerationEntryStatus)) {
    return null;
  }
  if (typeof value.prompt !== "string") return null;
  if (typeof value.modelId !== "string") return null;
  if (typeof value.aspectRatio !== "string") return null;
  if (!Number.isInteger(value.count) || (value.count as number) < 1) return null;
  if (value.presetId !== null && typeof value.presetId !== "string") return null;
  if (value.projectId !== null && typeof value.projectId !== "string") return null;
  if (!Array.isArray(value.referenceAssetIds) || !value.referenceAssetIds.every((id) => typeof id === "string")) {
    return null;
  }
  const batchVariants = parseBatchVariants(value.batchVariants);
  if (value.batchVariants !== null && batchVariants === null) return null;
  const generationParameters = parseGenerationParameters(value.generationParameters);
  if (!generationParameters) return null;
  if (!Array.isArray(value.assets) || !value.assets.every(isAssetDTO)) return null;
  if (!Array.isArray(value.warnings) || !value.warnings.every((warning) => typeof warning === "string")) {
    return null;
  }
  if (value.error !== null && typeof value.error !== "string") return null;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;

  const status = value.status as GenerationEntryStatus;
  return {
    id: value.id,
    mode: value.mode,
    // Persisted running cannot be live after reload.
    status: status === "running" ? "interrupted" : status,
    prompt: value.prompt,
    modelId: value.modelId,
    aspectRatio: value.aspectRatio,
    count: value.count as number,
    presetId: value.presetId as string | null,
    projectId: value.projectId as string | null,
    referenceAssetIds: value.referenceAssetIds as string[],
    batchVariants,
    generationParameters,
    assets: value.assets,
    warnings: value.warnings as string[],
    error: value.error as string | null,
    createdAt: value.createdAt,
  };
}

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
      const entry = parseHistoryEntry(item);
      if (!entry) continue;
      entries.push(entry);
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
