import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { restoreWorkspaceBackup } from "@/lib/server/workspace-backup";
import { readBoundedRestoreBody } from "@/lib/server/workspace-restore-limits";

/**
 * Replace the local workspace with a verified backup. Body:
 *   { backup: WorkspaceBackup, confirm: true }
 * Integrity- and confirmation-gated. Encoded/decoded size limits and disk
 * headroom are enforced before staging. This route deliberately does not
 * bootstrap the sample workspace before restore; the backup owns the
 * replacement rows.
 */
export async function POST(request: NextRequest) {
  try {
    await requireLocalWorkspaceOwner();
    const { backup, confirm } = await readBoundedRestoreBody(request);
    const result = await restoreWorkspaceBackup(backup, { confirm });
    return NextResponse.json({ restored: result });
  } catch (error) {
    return jsonError(error);
  }
}
