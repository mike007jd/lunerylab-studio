import "server-only";

import { ApiError } from "@/lib/server/errors";
import { prisma } from "@/lib/server/prisma";

interface ProjectOwnershipOptions {
  notFoundMessage?: string;
}

function projectNotFoundError(options: ProjectOwnershipOptions) {
  return new ApiError({
    status: 404,
    code: "project_not_found",
    message: options.notFoundMessage ?? "Project not found.",
    retryable: false,
  });
}

export async function assertOwnedProject(
  projectId: string,
  userId: string,
  options: ProjectOwnershipOptions = {},
): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId, userId },
    select: { id: true },
  });

  if (!project) {
    throw projectNotFoundError(options);
  }
}

export async function resolveOwnedProjectId(
  providedProjectId: string,
  userId: string,
  options: ProjectOwnershipOptions = {},
): Promise<string | null> {
  const projectId = providedProjectId.trim();
  if (!projectId) {
    return null;
  }

  await assertOwnedProject(projectId, userId, options);
  return projectId;
}
