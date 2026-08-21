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

/**
 * Ask the canvas window to report its current graph and resolve with the
 * fresh snapshot. Returns null when the canvas window is not open, the agent
 * is missing, or no beacon landed within `timeoutMs`.
 */
export async function refreshComfyCanvasReport(
  bridge: DesktopBridge,
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
    if (report && Date.parse(report.receivedAt) >= startedAt) return report;
  }
  // Fall back to any still-fresh cached snapshot so a flaky beacon does not
  // blind an agent that already has recent state.
  return getComfyCanvasReport();
}
