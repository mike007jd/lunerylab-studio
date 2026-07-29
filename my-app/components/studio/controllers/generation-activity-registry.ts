"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { GenerationMode } from "@/lib/schemas/studio-history";

export interface GenerationActivity {
  entryId: string;
  runId: string;
  mode: GenerationMode;
  requestController: AbortController;
  pollController: AbortController;
  cancelRequested: boolean;
  cancelAcknowledgement: Promise<void> | null;
}

const EMPTY_SNAPSHOT: ReadonlyMap<string, GenerationActivity> = new Map();
const GenerationActivityRegistryContext =
  createContext<GenerationActivityRegistry | null>(null);

export class GenerationActivityRegistry {
  private snapshot: ReadonlyMap<string, GenerationActivity> = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ReadonlyMap<string, GenerationActivity> => this.snapshot;

  readonly getServerSnapshot = (): ReadonlyMap<string, GenerationActivity> => EMPTY_SNAPSHOT;

  get(entryId: string): GenerationActivity | undefined {
    return this.snapshot.get(entryId);
  }

  isCurrent(entryId: string, runId: string): boolean {
    return this.snapshot.get(entryId)?.runId === runId;
  }

  anyActive(): boolean {
    return this.snapshot.size > 0;
  }

  begin(
    activity: Omit<GenerationActivity, "cancelRequested" | "cancelAcknowledgement">,
  ): boolean {
    if (this.snapshot.has(activity.entryId)) return false;
    const next = new Map(this.snapshot);
    next.set(activity.entryId, {
      ...activity,
      cancelRequested: false,
      cancelAcknowledgement: null,
    });
    this.publish(next);
    return true;
  }

  startCancellation(
    entryId: string,
    runId: string,
    cancelAcknowledgement: Promise<void>,
  ): boolean {
    const current = this.snapshot.get(entryId);
    if (!current || current.runId !== runId || current.cancelRequested) {
      return false;
    }
    const next = new Map(this.snapshot);
    next.set(entryId, {
      ...current,
      cancelRequested: true,
      cancelAcknowledgement,
    });
    this.publish(next);
    return true;
  }

  resetCancellation(entryId: string, runId: string): boolean {
    const current = this.snapshot.get(entryId);
    if (!current || current.runId !== runId || !current.cancelRequested) {
      return false;
    }
    const next = new Map(this.snapshot);
    next.set(entryId, {
      ...current,
      cancelRequested: false,
      cancelAcknowledgement: null,
    });
    this.publish(next);
    return true;
  }

  finish(entryId: string, runId: string): boolean {
    if (!this.isCurrent(entryId, runId)) return false;
    const next = new Map(this.snapshot);
    next.delete(entryId);
    this.publish(next.size === 0 ? EMPTY_SNAPSHOT : next);
    return true;
  }

  abortAll(): void {
    if (this.snapshot.size === 0) return;
    for (const activity of this.snapshot.values()) {
      activity.requestController.abort();
      activity.pollController.abort();
    }
    this.publish(EMPTY_SNAPSHOT);
  }

  private publish(snapshot: ReadonlyMap<string, GenerationActivity>): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Console-shell owner for in-flight generation. It shares the same lifetime as
 * Studio history so route navigation cannot detach a running entry from the
 * request or poll that will eventually terminalize it.
 */
export function GenerationActivityRegistryProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [registry] = useState(() => new GenerationActivityRegistry());
  useEffect(() => () => registry.abortAll(), [registry]);
  return createElement(
    GenerationActivityRegistryContext.Provider,
    { value: registry },
    children,
  );
}

export function useGenerationActivityRegistry() {
  const registry = useContext(GenerationActivityRegistryContext);
  if (!registry) {
    throw new Error(
      "useGenerationActivityRegistry must be used within GenerationActivityRegistryProvider.",
    );
  }
  const activities = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getServerSnapshot,
  );

  const isEntryGenerating = useCallback(
    (entryId: string) => activities.has(entryId),
    [activities],
  );

  return {
    registry,
    activities,
    anyGenerationActive: activities.size > 0,
    isEntryGenerating,
  };
}
