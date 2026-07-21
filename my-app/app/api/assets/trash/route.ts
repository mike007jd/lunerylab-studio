import { NextResponse } from "next/server";
import { jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { purgeAssets } from "@/lib/server/asset-purge";

/**
 * Empty Trash: permanently purge every soft-deleted asset for the workspace
 * owner, reclaiming disk (files) and removing the soft-deleted rows. This is
 * the destructive counterpart to the soft DELETE on /api/assets/[id]; the UI
 * must confirm before calling it.
 */
export async function DELETE() {
  try {
    const user = await requireLocalWorkspaceOwner();
    const result = await purgeAssets(user.id, "trash");
    return NextResponse.json({
      emptied: {
        count: result.purgedCount,
        bytesFreed: result.bytesFreed,
        filesDeleted: result.filesDeleted,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
