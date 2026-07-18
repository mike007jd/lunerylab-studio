import { NextResponse } from "next/server";
import { jsonError } from "@/lib/server/errors";
import { fetchBootstrapData } from "@/lib/server/queries";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";

// Route delegates to the shared `fetchBootstrapData` helper (the source of
// truth that is also consumed by the page-level server components). Keeping
// the assembly logic in one place stops the two surfaces from drifting on
// feature flags or provider-status shape.
export async function GET() {
  try {
    const user = await requireLocalWorkspaceOwner();
    const data = await fetchBootstrapData(user.id);

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
      app: data.app,
      features: data.features,
      providers: data.providers,
      providerConnections: data.providerConnections,
    });
  } catch (error) {
    return jsonError(error);
  }
}
