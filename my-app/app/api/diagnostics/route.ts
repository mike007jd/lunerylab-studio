import { NextResponse } from "next/server";
import { jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { buildDiagnosticsBundle } from "@/lib/server/diagnostics";

/**
 * Export a redacted diagnostics bundle for support. Excludes API keys, prompts,
 * reference images, and generated media; redacts home paths.
 */
export async function GET() {
  try {
    const user = await requireLocalWorkspaceOwner();
    const bundle = await buildDiagnosticsBundle(user.id);
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="lunery-diagnostics.json"`,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
