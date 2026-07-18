import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { reconcileStorage } from "@/lib/server/storage-reconcile";

/**
 * Reconcile the asset DB against files on disk. GET reports missing/orphan files;
 * POST with { deleteOrphans: true } additionally purges orphan files (a
 * destructive action the client opts into).
 */
export async function GET() {
  try {
    const user = await requireLocalWorkspaceOwner();
    const result = await reconcileStorage(user.id);
    return NextResponse.json({ reconcile: result });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const body = (await request.json().catch(() => ({}))) as { deleteOrphans?: unknown };
    const deleteOrphans = body.deleteOrphans === true;
    const result = await reconcileStorage(user.id, { deleteOrphans });
    return NextResponse.json({ reconcile: result });
  } catch (error) {
    return jsonError(error);
  }
}
