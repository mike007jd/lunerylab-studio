/**
 * Single canvas snapshot — GET (with body) + DELETE + POST restore.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/server/prisma";
import { ApiError, jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { requireWritableCanvasSession } from "@/lib/server/canvas-session-access";

interface Params {
  params: Promise<{ id: string; snapId: string }>;
}

async function loadSnapshot(snapId: string, sessionId: string, userId: string) {
  const session = await prisma.canvasSession.findUnique({
    where: { id: sessionId, userId },
    select: { id: true },
  });
  if (!session) {
    throw new ApiError({
      status: 404,
      code: "canvas_session_not_found",
      message: "Canvas session not found.",
      retryable: false,
    });
  }
  const snapshot = await prisma.canvasSnapshot.findUnique({ where: { id: snapId } });
  if (!snapshot || snapshot.sessionId !== sessionId) {
    throw new ApiError({
      status: 404,
      code: "snapshot_not_found",
      message: "Snapshot not found.",
      retryable: false,
    });
  }
  return snapshot;
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id, snapId } = await params;
    const snapshot = await loadSnapshot(snapId, id, user.id);
    return NextResponse.json({
      snapshot: {
        id: snapshot.id,
        label: snapshot.label,
        isAutomatic: snapshot.isAutomatic,
        data: snapshot.data,
        createdAt: snapshot.createdAt.toISOString(),
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id, snapId } = await params;
    await requireWritableCanvasSession(id, user.id);
    await loadSnapshot(snapId, id, user.id);
    await prisma.canvasSnapshot.delete({ where: { id: snapId } });
    return new Response(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
