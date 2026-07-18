import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import { ApiError, jsonError } from "@/lib/server/errors";
import { luneryProfileRoot } from "@/lib/server/lunery-profile";

const run = promisify(execFile);

export async function POST() {
  try {
    if (!isDesktopRuntime()) {
      throw new ApiError({
        status: 404,
        code: "desktop_runtime_unavailable",
        message: "Desktop runtime is not available.",
        retryable: false,
      });
    }

    const folder = luneryProfileRoot();
    await fs.mkdir(folder, { recursive: true });
    await openInFileManager(folder);
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
      await run("explorer", [folder]).catch(() => undefined);
    } else {
      await run("xdg-open", [folder]);
    }
  } catch {
    throw new ApiError({
      status: 500,
      code: "open_profile_folder_failed",
      message: "Could not open the local data folder.",
      retryable: false,
    });
  }
}
