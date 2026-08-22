// Close the native ComfyUI canvas window.

import { NextResponse } from "next/server";
import { requireDesktopBridge, proxyToBridge } from "@/lib/server/desktop-bridge";
import { jsonError } from "@/lib/server/errors";
import { ensureWorkspaceRestoreReconciled } from "@/lib/server/workspace-restore-journal";
import { setCurrentCanvasEndpoint } from "@/lib/server/comfy-canvas-report";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;
    await ensureWorkspaceRestoreReconciled();
    // The canvas is gone; no beacon should be attributed to any connection.
    setCurrentCanvasEndpoint(null);
    return proxyToBridge(bridge, "/comfy-canvas-close", { method: "POST", body: "{}" });
  } catch (error) {
    return jsonError(error);
  }
}
