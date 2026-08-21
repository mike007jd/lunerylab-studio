// Select which saved ComfyUI connection the workspace embeds and image
// generation prefers.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";
import { setActiveComfyConnection } from "@/lib/server/comfy-connection-store";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { ensureWorkspaceRestoreReconciled } from "@/lib/server/workspace-restore-journal";

export const dynamic = "force-dynamic";

const activateSchema = z
  .object({
    id: z.string().trim().min(1),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;
    await ensureWorkspaceRestoreReconciled();
    await requireLocalWorkspaceOwner();

    const { id } = await parseJsonBody(request, activateSchema);
    try {
      await setActiveComfyConnection(id);
    } catch {
      return NextResponse.json({ error: "ComfyUI connection not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
