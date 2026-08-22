// Launch a remote ComfyUI through its saved SSH start command.
//
// Forwards to the native bridge `/comfy-ssh-start`, which runs
// `ssh <hostAlias> <command>` as argv (no local shell). Both halves were
// shape-validated when the connection was saved; the bridge re-validates.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bridgeFetch, bridgeErrorText, requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";
import { getComfyConnection } from "@/lib/server/comfy-connection-store";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { ensureWorkspaceRestoreReconciled } from "@/lib/server/workspace-restore-journal";

export const dynamic = "force-dynamic";

const startSchema = z
  .object({
    id: z.string().trim().min(1),
  })
  .strict();

// The bridge bounds the ssh call itself (25s); leave headroom for the round
// trip so the route does not cut a still-running start short.
const START_TIMEOUT_MS = 30_000;

export async function POST(request: NextRequest) {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;
    await ensureWorkspaceRestoreReconciled();
    await requireLocalWorkspaceOwner();

    const { id } = await parseJsonBody(request, startSchema);
    const connection = getComfyConnection(id);
    if (!connection) {
      return NextResponse.json({ error: "ComfyUI connection not found." }, { status: 404 });
    }
    if (!connection.sshStart) {
      return NextResponse.json(
        { error: "This connection has no SSH start command configured." },
        { status: 400 },
      );
    }

    const response = await bridgeFetch(bridge, "/comfy-ssh-start", {
      method: "POST",
      body: JSON.stringify({
        hostAlias: connection.sshStart.hostAlias,
        command: connection.sshStart.command,
      }),
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
    });
    const text = await bridgeErrorText(response);
    return new NextResponse(text, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    return jsonError(error);
  }
}
