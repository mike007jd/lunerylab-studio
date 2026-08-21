// ComfyUI attach connections — list / save / delete.
//
// The endpoint is validated (validateComfyEndpoint) at this trust boundary
// before it is ever persisted or fetched: stored endpoints are later used as
// iframe targets and generation dispatch targets.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import { validateComfyEndpoint } from "@/lib/server/comfy-endpoint";
import {
  deleteComfyConnection,
  getComfyConnection,
  getComfyConnectionState,
  saveComfyConnection,
} from "@/lib/server/comfy-connection-store";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { withSharedWorkspaceRead } from "@/lib/server/workspace-operation-gate";
import { ensureWorkspaceRestoreReconciled } from "@/lib/server/workspace-restore-journal";

export const dynamic = "force-dynamic";

const SSH_HOST_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const connectionPostSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).max(64),
    endpoint: z.string().trim().min(1).max(2000),
    sshStart: z
      .object({
        hostAlias: z.string().trim().min(1).max(64),
        command: z.string().trim().min(1).max(200),
      })
      .strict()
      .optional(),
  })
  .strict();

const connectionDeleteSchema = z
  .object({
    id: z.string().trim().min(1),
  })
  .strict();

export async function GET() {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;
    await ensureWorkspaceRestoreReconciled();
    return await withSharedWorkspaceRead(async () =>
      NextResponse.json(getComfyConnectionState()),
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;
    await ensureWorkspaceRestoreReconciled();
    await requireLocalWorkspaceOwner();

    const body = await parseJsonBody(request, connectionPostSchema);

    // The SSH start pair is executed later by the native bridge as
    // `ssh <hostAlias> <command>` (argv, no shell). Keep both halves strictly
    // shaped here so the stored form can never smuggle ssh options.
    if (body.sshStart) {
      if (!SSH_HOST_ALIAS_PATTERN.test(body.sshStart.hostAlias)) {
        return NextResponse.json(
          { error: "SSH host alias may only contain letters, digits, dots, dashes, and underscores." },
          { status: 400 },
        );
      }
      if (/[\r\n\0]/.test(body.sshStart.command)) {
        return NextResponse.json(
          { error: "SSH start command must be a single line." },
          { status: 400 },
        );
      }
    }

    const endpointCheck = await validateComfyEndpoint(body.endpoint);
    if ("error" in endpointCheck) {
      return NextResponse.json({ error: endpointCheck.error }, { status: 400 });
    }

    if (body.id && !getComfyConnection(body.id)) {
      return NextResponse.json({ error: "ComfyUI connection not found." }, { status: 404 });
    }

    try {
      const connection = await saveComfyConnection({
        ...(body.id ? { id: body.id } : {}),
        name: body.name,
        endpoint: endpointCheck.url,
        sshStart: body.sshStart,
      });
      return NextResponse.json({ ok: true, connection });
    } catch (error) {
      // Persistence failed; the store left memory untouched — report it
      // instead of a misleading ok.
      console.error("[comfy-connections] failed to persist:", error);
      return NextResponse.json({ error: "persist_failed" }, { status: 500 });
    }
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // Connections are owned by the local profile, not by the native bridge.
    // Keep browser access denied, but do not let a bridge outage prevent the
    // user from removing a saved ComfyUI connection.
    if (!isDesktopRuntime()) {
      return NextResponse.json(
        { error: "Desktop runtime bridge is not available" },
        { status: 404 },
      );
    }
    await ensureWorkspaceRestoreReconciled();
    await requireLocalWorkspaceOwner();
    const { id } = await parseJsonBody(request, connectionDeleteSchema);
    try {
      await deleteComfyConnection(id);
    } catch (error) {
      console.error("[comfy-connections] failed to delete:", error);
      return NextResponse.json({ error: "persist_failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
