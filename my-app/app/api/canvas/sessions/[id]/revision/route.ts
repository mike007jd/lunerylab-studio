import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/server/prisma";
import { jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { canvasSessionNotFoundError } from "../../_session-route-helpers";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;
    const session = await prisma.canvasSession.findUnique({
      where: { id, userId: user.id },
      select: {
        updatedAt: true,
        _count: { select: { layers: true } },
        layers: {
          select: { updatedAt: true },
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
      },
    });
    if (!session) throw canvasSessionNotFoundError();
    const latestLayerRevision = session.layers[0]?.updatedAt.toISOString() ?? "";
    const revision = [
      session.updatedAt.toISOString(),
      session._count.layers,
      latestLayerRevision,
    ].join("|");
    return NextResponse.json({ revision });
  } catch (error) {
    return jsonError(error);
  }
}
