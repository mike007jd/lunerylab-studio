// Latest canvas graph report pushed by the ComfyUI canvas window.
//
// The canvas window's frame agent serializes the live graph
// (`app.graphToPrompt()`) and beacons it here so the ComfyUI agent can read
// what the user is actually editing. Memory-only, same pattern as
// comfy-activity: nothing about the graph is persisted to disk.

import "server-only";

export interface ComfyCanvasReport {
  /** API-format workflow (the POST /prompt shape), keyed by node id. */
  prompt: Record<string, unknown>;
  /** UI-format graph (positions, groups) when the frontend provided it. */
  workflow?: Record<string, unknown>;
  /**
   * The attached connection's endpoint that was active when this report was
   * stored. Readers must match it against the connection they are operating on
   * so a stale beacon can never feed one server's graph to another server's
   * agent (single global slot, one canvas window at a time).
   */
  connectionEndpoint?: string;
  receivedAt: string;
}

const CACHE_KEY = "__luneryComfyCanvasReport" as const;

const reportGlobal = globalThis as typeof globalThis & {
  [CACHE_KEY]?: ComfyCanvasReport | null;
};

reportGlobal[CACHE_KEY] = null;

/** A report older than this is treated as absent by readers. */
export const CANVAS_REPORT_TTL_MS = 30_000;

/** The canvas window is only ever served from the bridge's loopback relay. */
export function isComfyRelayOrigin(origin: string | null): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    /^(8189|819[0-9])$/.test(url.port)
  );
}

export function storeComfyCanvasReport(
  report: Omit<ComfyCanvasReport, "receivedAt">,
): ComfyCanvasReport {
  const stored: ComfyCanvasReport = { ...report, receivedAt: new Date().toISOString() };
  reportGlobal[CACHE_KEY] = stored;
  return stored;
}

export function getComfyCanvasReport(): ComfyCanvasReport | null {
  const report = reportGlobal[CACHE_KEY];
  if (!report) return null;
  const age = Date.now() - Date.parse(report.receivedAt);
  if (!Number.isFinite(age) || age > CANVAS_REPORT_TTL_MS) return null;
  return report;
}

export function resetComfyCanvasReportForTests(): void {
  reportGlobal[CACHE_KEY] = null;
}
