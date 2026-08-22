// Trigger a canvas graph report and wait for it to land in the cache.
//
// The bridge eval is fire-and-forget: the canvas window serializes its graph
// asynchronously and beacons `/api/comfy/canvas/report` a moment later. This
// helper bridges that gap by polling the report cache for a snapshot that
// arrived after the trigger.

import "server-only";
import type { DesktopBridge } from "@/lib/server/desktop-bridge";
import { proxyToBridge } from "@/lib/server/desktop-bridge";
import {
  getComfyCanvasReport,
  type ComfyCanvasReport,
} from "@/lib/server/comfy-canvas-report";

const POLL_INTERVAL_MS = 150;

/** A cached report only counts for the connection whose graph it holds. */
function matchesConnection(
  report: ComfyCanvasReport | null,
  expectedEndpoint: string,
): report is ComfyCanvasReport {
  return report?.connectionEndpoint === expectedEndpoint;
}

/**
 * Ask the canvas window to report its current graph and resolve with the
 * fresh snapshot for `expectedEndpoint`. Returns null when the canvas window
 * is not open, the agent is missing, no beacon landed within `timeoutMs`, or
 * the only cached report belongs to a different attached server. Never returns
 * another connection's graph — that would let the agent edit or queue the
 * wrong workflow.
 */
export async function refreshComfyCanvasReport(
  bridge: DesktopBridge,
  expectedEndpoint: string,
  timeoutMs = 4_000,
): Promise<ComfyCanvasReport | null> {
  const startedAt = Date.now();
  const response = await proxyToBridge(bridge, "/comfy-canvas-report", {
    method: "POST",
    body: "{}",
    timeoutMs: 3_000,
  });
  if (!response.ok) return null;

  const deadline = startedAt + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const report = getComfyCanvasReport();
    if (matchesConnection(report, expectedEndpoint) && Date.parse(report.receivedAt) >= startedAt) {
      return report;
    }
  }
  // Fall back to a still-fresh snapshot only when it belongs to this same
  // connection, so a flaky beacon does not blind an agent that already has
  // recent state — but a different server's graph is never substituted.
  const cached = getComfyCanvasReport();
  return matchesConnection(cached, expectedEndpoint) ? cached : null;
}
