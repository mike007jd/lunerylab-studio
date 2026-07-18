import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { deleteTemporaryCanvasMask } from "@/lib/server/canvas-temporary-mask";

interface Params {
  params: Promise<{ token: string }>;
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    await requireLocalWorkspaceOwner();
    const { token } = await params;
    await deleteTemporaryCanvasMask(token);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return jsonError(error);
  }
}
