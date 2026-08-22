// Report the native ComfyUI canvas window's live state so the workspace can
// reconcile its UI with reality — the window can be closed by the user directly,
// and a fresh page mount starts with no knowledge of an already-open canvas.
//
// `open` is the window's actual presence (owned by Rust); `endpoint` is the
// connection the canvas is currently attached to (the raw stored endpoint set at
// open/retarget time). The client compares `endpoint` to the active connection
// to detect and repair drift.

import { NextResponse } from "next/server";
import { requireDesktopBridge, proxyToBridge } from "@/lib/server/desktop-bridge";
import { jsonError } from "@/lib/server/errors";
import { ensureWorkspaceRestoreReconciled } from "@/lib/server/workspace-restore-journal";
import { getCurrentCanvasEndpoint } from "@/lib/server/comfy-canvas-report";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;
    await ensureWorkspaceRestoreReconciled();

    let open = false;
    const status = await proxyToBridge(bridge, "/comfy-canvas-status");
    if (status.ok) {
      const payload = (await status.json().catch(() => null)) as { open?: unknown } | null;
      open = payload?.open === true;
    }
    // The bound endpoint is meaningful only while a window is actually open.
    const endpoint = open ? getCurrentCanvasEndpoint() : null;
    return NextResponse.json({ open, endpoint });
  } catch (error) {
    return jsonError(error);
  }
}
