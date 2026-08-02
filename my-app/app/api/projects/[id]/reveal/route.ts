import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ApiError, jsonError } from "@/lib/server/errors";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import { ensureStorageSubdirectory } from "@/lib/server/storage";
import { prisma } from "@/lib/server/prisma";
import { withSharedMutationLease } from "@/lib/server/workspace-operation-gate";

const run = promisify(execFile);

/** POST /api/projects/[id]/reveal — open the project's on-disk output folder in
 * the OS file manager. Desktop-only (the Next server runs inside the Tauri app's
 * Node process). The folder path is resolved server-side from the owned project
 * id via the storage validator — never from a client-supplied path. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await requireLocalWorkspaceOwner();

    if (!isDesktopRuntime()) {
      throw new ApiError({
        status: 400,
        code: "reveal_desktop_only",
        message: "Revealing files is only available in the desktop app.",
        retryable: false,
      });
    }

    const project = await prisma.project.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!project) {
      throw new ApiError({
        status: 404,
        code: "project_not_found",
        message: "Project not found.",
        retryable: false,
      });
    }

    await withSharedMutationLease(async () => {
      // A project with no outputs yet has no folder. Create it through the
      // canonical no-follow storage path and keep restore excluded until the
      // file manager launch has consumed that verified directory.
      const folder = await ensureStorageSubdirectory(`generated/${project.id}`);
      await openInFileManager(folder);
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

async function openInFileManager(folder: string): Promise<void> {
  try {
    if (process.platform === "darwin") {
      await run("open", [folder]);
    } else if (process.platform === "win32") {
      // explorer exits non-zero even on success — treat any outcome as opened.
      await run("explorer", [folder]).catch(() => undefined);
    } else {
      await run("xdg-open", [folder]);
    }
  } catch {
    throw new ApiError({
      status: 500,
      code: "reveal_failed",
      message: "Could not open the project folder.",
      retryable: false,
    });
  }
}
