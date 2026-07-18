import { NextRequest, NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/server/errors";
import { restoreWorkspaceBackup, type WorkspaceBackup } from "@/lib/server/workspace-backup";

/**
 * Replace the local workspace with a verified backup. Body:
 *   { backup: WorkspaceBackup, confirm: true }
 * Integrity- and confirmation-gated. This route deliberately does not bootstrap
 * the sample workspace before restore; the backup owns the replacement rows.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as
      | { backup?: WorkspaceBackup; confirm?: unknown }
      | null;
    if (!body?.backup) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "Request must include a backup payload.",
        retryable: false,
      });
    }
    const result = await restoreWorkspaceBackup(body.backup, { confirm: body.confirm === true });
    return NextResponse.json({ restored: result });
  } catch (error) {
    return jsonError(error);
  }
}
