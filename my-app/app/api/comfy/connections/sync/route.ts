// Sync a saved ComfyUI connection: pull /system_stats plus every model folder
// into a persisted snapshot so the workspace can show what that server runs.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";
import {
  COMFY_MODEL_FOLDERS,
  fetchComfyModelFolder,
  fetchComfySystemStats,
  validateComfyEndpoint,
} from "@/lib/server/comfy-endpoint";
import {
  getComfyConnection,
  setComfySyncSnapshot,
} from "@/lib/server/comfy-connection-store";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { ensureWorkspaceRestoreReconciled } from "@/lib/server/workspace-restore-journal";

export const dynamic = "force-dynamic";

const syncSchema = z
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

    const { id } = await parseJsonBody(request, syncSchema);
    const connection = getComfyConnection(id);
    if (!connection) {
      return NextResponse.json({ error: "ComfyUI connection not found." }, { status: 404 });
    }

    const endpointCheck = await validateComfyEndpoint(connection.endpoint);
    if ("error" in endpointCheck) {
      return NextResponse.json({ error: endpointCheck.error }, { status: 400 });
    }

    try {
      // Re-validate on read like every other trust boundary: the stored string
      // was validated at save, but DNS may have changed since.
      const system = await fetchComfySystemStats(endpointCheck);
      const folderEntries = await Promise.all(
        COMFY_MODEL_FOLDERS.map(async (folder) => {
          try {
            return [folder, await fetchComfyModelFolder(endpointCheck, folder)] as const;
          } catch {
            // Missing folder on this server (404) or a transient failure —
            // sync keeps going; the folder just stays absent from the snapshot.
            return null;
          }
        }),
      );
      const models: Record<string, string[]> = {};
      let modelCount = 0;
      for (const entry of folderEntries) {
        if (!entry) continue;
        models[entry[0]] = entry[1];
        modelCount += entry[1].length;
      }

      const updated = await setComfySyncSnapshot(id, {
        at: new Date().toISOString(),
        system,
        models,
      });
      return NextResponse.json({
        ok: true,
        connection: updated,
        modelCount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "ComfyUI sync failed.";
      return NextResponse.json({ ok: false, error: message }, { status: 200 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
