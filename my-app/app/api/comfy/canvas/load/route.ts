// Load an API-format workflow into the native ComfyUI canvas window's official
// frontend. Used by the Studio so a running job's graph shows up on the canvas
// with live node highlighting, and by the agent's edit_graph tool.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";
import { ensureWorkspaceRestoreReconciled } from "@/lib/server/workspace-restore-journal";
import { loadWorkflowOnCanvas } from "@/lib/server/comfy-agent/canvas-bridge";

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
    await loadWorkflowOnCanvas(bridge, body.workflow);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
