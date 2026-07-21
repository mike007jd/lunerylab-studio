import { NextResponse } from "next/server";
import { jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { getStorageBreakdown } from "@/lib/server/storage-breakdown";

/**
 * Storage breakdown for the workspace owner: active vs trash asset footprint,
 * models and logs size, and free disk. Surfaces that Trash still occupies space
 * until it is emptied (DELETE /api/assets/trash).
 */
export async function GET() {
  try {
    const user = await requireLocalWorkspaceOwner();
    const breakdown = await getStorageBreakdown(user.id);
    return NextResponse.json({ breakdown });
  } catch (error) {
    return jsonError(error);
  }
}
