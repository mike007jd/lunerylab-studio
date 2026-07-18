import "server-only";

import { ApiError } from "@/lib/server/errors";
import { prisma } from "@/lib/server/prisma";

export async function requireWritableCanvasSession(sessionId: string, userId: string) {
  const session = await prisma.canvasSession.findUnique({
    where: { id: sessionId, userId },
    select: {
      id: true,
      projectId: true,
      project: { select: { isTemplate: true } },
    },
  });
  if (!session) {
    throw new ApiError({
      status: 404,
      code: "canvas_session_not_found",
      message: "Canvas session not found.",
      retryable: false,
    });
  }
  if (session.project?.isTemplate) {
    throw new ApiError({
      status: 409,
      code: "template_project_read_only",
      message: "Use this template to create a project before editing it in Canvas.",
      retryable: false,
    });
  }
  return session;
}
