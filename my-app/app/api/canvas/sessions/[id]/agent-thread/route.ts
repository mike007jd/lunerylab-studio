import { NextResponse } from "next/server";
import { jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { listAgentThreadMessages } from "@/lib/server/agent/task-store";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;
    const messages = await listAgentThreadMessages(id, user.id);
    return NextResponse.json({ messages });
  } catch (error) {
    return jsonError(error);
  }
}
