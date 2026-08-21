// Load an API-format workflow into the native ComfyUI canvas window's official
// frontend. Used by the Studio so a running job's graph shows up on the canvas
// with live node highlighting.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireDesktopBridge, proxyToBridge } from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";
import { ensureWorkspaceRestoreReconciled } from "@/lib/server/workspace-restore-journal";

export const dynamic = "force-dynamic";

// Structural pass-through: the bridge forwards the JSON to the frontend, whose
// loadApiJson validates node types against object_info.
const canvasLoadSchema = z.object({ workflow: z.record(z.string(), z.unknown()) }).strict();

export async function POST(request: NextRequest) {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;
    await ensureWorkspaceRestoreReconciled();

    const body = await parseJsonBody(request, canvasLoadSchema);
    return proxyToBridge(bridge, "/comfy-canvas-load", {
      method: "POST",
      body: JSON.stringify({ workflow: body.workflow }),
    });
  } catch (error) {
    return jsonError(error);
  }
}
