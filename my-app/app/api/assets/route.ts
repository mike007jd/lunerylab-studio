import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/server/errors";
import { fetchAssets } from "@/lib/server/queries";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";

export async function GET(request: NextRequest) {
  try {
    const user = await requireLocalWorkspaceOwner();

    const unassigned = request.nextUrl.searchParams.get("unassigned") === "true";
    const cursor = request.nextUrl.searchParams.get("cursor")?.trim() || undefined;
    const limitParam = request.nextUrl.searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    const page = await fetchAssets(user.id, { unassigned, cursor, limit });

    return NextResponse.json(page);
  } catch (error) {
    return jsonError(error);
  }
}
