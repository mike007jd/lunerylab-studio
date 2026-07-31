import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { DESKTOP_WORKSPACE_RESET_CONFIRMATION } from "@/lib/desktop-workspace-reset";
import { proxyToBridge, requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";

export const dynamic = "force-dynamic";

const resetWorkspaceBodySchema = z.object({
  confirmation: z.literal(DESKTOP_WORKSPACE_RESET_CONFIRMATION),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonBody(request, resetWorkspaceBodySchema);
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;

    return proxyToBridge(bridge, "/reset-workspace", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (error) {
    return jsonError(error);
  }
}
