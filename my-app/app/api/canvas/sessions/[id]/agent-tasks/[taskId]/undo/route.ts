import { NextResponse } from "next/server";
import { jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { requireWritableCanvasSession } from "@/lib/server/canvas-session-access";
import { undoAgentTask } from "@/lib/server/restore-agent-task";

interface Params { params: Promise<{ id: string; taskId: string }> }

export async function POST(_request: Request, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id, taskId } = await params;
    await requireWritableCanvasSession(id, user.id);
    await undoAgentTask({ taskId, sessionId: id, userId: user.id });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
