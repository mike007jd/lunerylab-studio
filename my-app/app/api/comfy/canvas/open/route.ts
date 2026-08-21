// Open (or focus) the native ComfyUI canvas window for a saved connection.
//
// The window loads the official ComfyUI frontend. Plain-http endpoints are
// reached through the desktop bridge's loopback relay (stable origin, no macOS
// Local Network Privacy exposure for the WebView); https endpoints are loaded
// directly.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireDesktopBridge, proxyToBridge } from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";
import { validateComfyEndpoint } from "@/lib/server/comfy-endpoint";
import {
  getActiveComfyConnection,
  getComfyConnection,
} from "@/lib/server/comfy-connection-store";
import { withSharedWorkspaceRead } from "@/lib/server/workspace-operation-gate";
import { ensureWorkspaceRestoreReconciled } from "@/lib/server/workspace-restore-journal";

export const dynamic = "force-dynamic";

const canvasOpenSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    // Force a fresh page load of an already-open canvas (explicit user action).
    reload: z.boolean().optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;
    await ensureWorkspaceRestoreReconciled();

    const body = await parseJsonBody(request, canvasOpenSchema);

    return await withSharedWorkspaceRead(async () => {
      const connection = body.id ? getComfyConnection(body.id) : getActiveComfyConnection();
      if (!connection) {
        return NextResponse.json({ error: "ComfyUI connection not found." }, { status: 404 });
      }

      // Same trust boundary as every other consumer of a stored endpoint.
      const endpointCheck = await validateComfyEndpoint(connection.endpoint);
      if ("error" in endpointCheck) {
        return NextResponse.json({ error: endpointCheck.error }, { status: 400 });
      }

      return proxyToBridge(bridge, "/comfy-canvas-open", {
        method: "POST",
        body: JSON.stringify({
          endpoint: endpointCheck.url,
          ...(body.reload ? { reload: true } : {}),
        }),
      });
    });
  } catch (error) {
    return jsonError(error);
  }
}
