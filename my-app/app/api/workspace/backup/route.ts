import { NextResponse } from "next/server";
import { jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { exportWorkspaceBackup } from "@/lib/server/workspace-backup";

/**
 * Export a full workspace backup (DB + media + manifest). Keychain secrets are
 * excluded by design.
 */
export async function GET() {
  try {
    await requireLocalWorkspaceOwner();
    const backup = await exportWorkspaceBackup(new Date().toISOString());
    return new NextResponse(JSON.stringify(backup), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="lunery-workspace-backup.json"`,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
