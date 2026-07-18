"use client";

const PENDING_REFERENCE_KEY = "luna:pending-reference";
const PERMANENT_REFERENCE_FAILURE_STATUSES = new Set([400, 404, 410, 422]);

export type PendingReferenceFetchResult =
  | { kind: "success"; blob: Blob; contentType: string; extension: string }
  | { kind: "permanent-failure" }
  | { kind: "transient-failure" };

type ReferenceFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function storePendingReferenceAsset(assetId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(PENDING_REFERENCE_KEY, assetId);
    return true;
  } catch {
    return false;
  }
}

export function readPendingReferenceAsset(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(PENDING_REFERENCE_KEY);
  } catch {
    return null;
  }
}

export function clearPendingReferenceAsset(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PENDING_REFERENCE_KEY);
  } catch {
    // Session storage may be blocked; callers decide how to surface failures.
  }
}

export function shouldClearPendingReference(result: PendingReferenceFetchResult): boolean {
  return result.kind !== "transient-failure";
}

/**
 * Fetches a Library handoff without consuming its sessionStorage intent.
 * Callers clear the intent only for a materialized image or a definitively
 * invalid asset; aborts, network failures, throttling and server failures stay
 * retryable on the next Studio mount.
 */
export async function fetchPendingReference(
  assetId: string,
  signal?: AbortSignal,
  fetcher: ReferenceFetcher = fetch,
): Promise<PendingReferenceFetchResult> {
  if (signal?.aborted) return { kind: "transient-failure" };

  try {
    const response = await fetcher(`/api/assets/${encodeURIComponent(assetId)}`, { signal });
    if (signal?.aborted) return { kind: "transient-failure" };
    if (!response.ok) {
      return PERMANENT_REFERENCE_FAILURE_STATUSES.has(response.status)
        ? { kind: "permanent-failure" }
        : { kind: "transient-failure" };
    }

    const blob = await response.blob();
    if (signal?.aborted) return { kind: "transient-failure" };
    const contentType = (response.headers.get("content-type") || blob.type)
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (!contentType.startsWith("image/") || blob.size === 0) {
      return { kind: "permanent-failure" };
    }

    const rawSubtype = contentType.slice("image/".length);
    const extension = rawSubtype === "svg+xml"
      ? "svg"
      : rawSubtype.replace(/[^a-z0-9]/g, "") || "img";
    return { kind: "success", blob, contentType, extension };
  } catch {
    return { kind: "transient-failure" };
  }
}
