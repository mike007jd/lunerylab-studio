interface DrawingStateLifecycleFlushTarget {
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
}

const KEEPALIVE_BODY_BUDGET_BYTES = 60 * 1024;

export function canUseDrawingStateKeepalive(body: string): boolean {
  return new TextEncoder().encode(body).byteLength <= KEEPALIVE_BODY_BUDGET_BYTES;
}

export function canReportCanvasSaved({
  inFlightWrites,
  drawingStateDirty,
  dirtyGeometryLayers,
}: {
  inFlightWrites: number;
  drawingStateDirty: boolean;
  dirtyGeometryLayers: number;
}): boolean {
  return inFlightWrites === 0 && !drawingStateDirty && dirtyGeometryLayers === 0;
}

export function canClearDirtyGeometry(hasDebouncedPatch: boolean): boolean {
  return !hasDebouncedPatch;
}

/**
 * React removes parent passive effects before child passive effects. Defer a
 * parent-owned writer's disposal by one microtask so a child can synchronously
 * publish its final live snapshot during cleanup.
 */
export function deferDrawingQueueDisposal(dispose: () => void): void {
  queueMicrotask(dispose);
}

export function findServerDeletedDirtyLayerIds<T extends { id: string }>(
  incoming: readonly T[],
  dirtyIds: ReadonlySet<string>,
  preserveMissingIds: ReadonlySet<string>,
): string[] {
  const incomingIds = new Set(incoming.map((layer) => layer.id));
  return [...dirtyIds].filter(
    (id) => !incomingIds.has(id) && !preserveMissingIds.has(id),
  );
}

/** Geometry fields owned by the local debounced writer while a layer is dirty. */
const DIRTY_GEOMETRY_KEYS = ["x", "y", "width", "height", "rotation"] as const;

function takeLocalDirtyGeometry<T extends { id: string }>(local: T): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of DIRTY_GEOMETRY_KEYS) {
    if (key in local) {
      patch[key as keyof T] = local[key as keyof T];
    }
  }
  return patch;
}

/**
 * Merge a polled server snapshot with locally dirty layers. Dirty ids keep only
 * their in-flight geometry; lock, hidden, z-index, asset identity, and every
 * other server field stay authoritative so a poll cannot conceal a lock.
 */
export function mergePolledLayers<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
  dirtyIds: ReadonlySet<string>,
  options: {
    deletedIds?: ReadonlySet<string>;
    preserveMissingIds?: ReadonlySet<string>;
  } = {},
): T[] {
  const deletedIds = options.deletedIds ?? new Set<string>();
  const preserveMissingIds = options.preserveMissingIds ?? new Set<string>();
  const visibleIncoming = incoming.filter((layer) => !deletedIds.has(layer.id));
  if (dirtyIds.size === 0 && preserveMissingIds.size === 0) return visibleIncoming;
  const currentById = new Map(current.map((layer) => [layer.id, layer]));
  const incomingIds = new Set(visibleIncoming.map((layer) => layer.id));
  const merged = visibleIncoming.map((layer) => {
    if (!dirtyIds.has(layer.id)) return layer;
    const local = currentById.get(layer.id);
    if (!local) return layer;
    return { ...layer, ...takeLocalDirtyGeometry(local) };
  });
  for (const layer of current) {
    if (
      !deletedIds.has(layer.id) &&
      !incomingIds.has(layer.id) &&
      preserveMissingIds.has(layer.id)
    ) {
      merged.push(layer);
    }
  }
  return merged;
}

export function bindUnsavedCanvasGuard({
  windowTarget,
  isDirty,
}: {
  windowTarget: DrawingStateLifecycleFlushTarget;
  isDirty: () => boolean;
}): () => void {
  const onBeforeUnload: EventListener = (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = "";
  };
  windowTarget.addEventListener("beforeunload", onBeforeUnload);
  return () => windowTarget.removeEventListener("beforeunload", onBeforeUnload);
}
