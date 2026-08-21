// Test a ComfyUI endpoint with GET /system_stats.
//
// Accepts either a saved connection id or a raw endpoint (form editing wants
// to test before saving). Raw endpoints go through the same validation as
// saved ones — never send traffic to an unvalidated host.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";
import { fetchComfySystemStats, validateComfyEndpoint } from "@/lib/server/comfy-endpoint";
import { getComfyConnection } from "@/lib/server/comfy-connection-store";
import { withSharedWorkspaceRead } from "@/lib/server/workspace-operation-gate";
import { ensureWorkspaceRestoreReconciled } from "@/lib/server/workspace-restore-journal";

export const dynamic = "force-dynamic";

const testSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    endpoint: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;
    await ensureWorkspaceRestoreReconciled();

    const body = await parseJsonBody(request, testSchema);
    if (!body.id && !body.endpoint) {
      return NextResponse.json({ error: "Provide a connection id or an endpoint." }, { status: 400 });
    }

    return await withSharedWorkspaceRead(async () => {
      let endpointValue = body.endpoint;
      if (body.id) {
        const connection = getComfyConnection(body.id);
        if (!connection) {
          return NextResponse.json({ error: "ComfyUI connection not found." }, { status: 404 });
        }
        endpointValue = connection.endpoint;
      }

      const endpointCheck = await validateComfyEndpoint(endpointValue!);
      if ("error" in endpointCheck) {
        return NextResponse.json({ error: endpointCheck.error }, { status: 400 });
      }

      try {
        const systemStats = await fetchComfySystemStats(endpointCheck);
        return NextResponse.json({ ok: true, endpoint: endpointCheck.url, systemStats });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "ComfyUI connection test failed.";
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "comfy_unreachable";
        return NextResponse.json({ ok: false, error: message, code }, { status: 200 });
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
