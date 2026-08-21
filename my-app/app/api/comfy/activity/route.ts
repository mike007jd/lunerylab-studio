// Recent ComfyUI jobs submitted by Studio (see lib/server/comfy-activity.ts).
//
// The /comfy workspace polls this while visible: a running job for the active
// connection is loaded into the embedded canvas so the user watches the real
// graph execute. Memory-only feed — no persistence, no secrets.

import { NextResponse } from "next/server";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { jsonError } from "@/lib/server/errors";
import { listRecentComfyJobs } from "@/lib/server/comfy-activity";
import { withSharedWorkspaceRead } from "@/lib/server/workspace-operation-gate";
import { ensureWorkspaceRestoreReconciled } from "@/lib/server/workspace-restore-journal";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;
    await ensureWorkspaceRestoreReconciled();
    return await withSharedWorkspaceRead(async () =>
      NextResponse.json({ jobs: listRecentComfyJobs() }),
    );
  } catch (error) {
    return jsonError(error);
  }
}
