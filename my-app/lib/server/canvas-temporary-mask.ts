import "server-only";

import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { ApiError } from "@/lib/server/errors";
import { sniffImageMime } from "@/lib/server/byok-shared";
import { luneryRuntimeDir } from "@/lib/server/lunery-profile";

const TOKEN_PATTERN = /^cm_(\d{13})_([a-f0-9]{32})$/;
const MAX_MASK_AGE_MS = 15 * 60_000;

function temporaryMaskDirectory(): string {
  return path.join(luneryRuntimeDir(), "canvas-masks");
}

function temporaryMaskPath(token: string): string {
  if (!TOKEN_PATTERN.test(token)) {
    throw new ApiError({
      status: 400,
      code: "invalid_canvas_mask",
      message: "Canvas mask token is invalid.",
      retryable: false,
    });
  }
  return path.join(temporaryMaskDirectory(), `${token}.png`);
}

export function isTemporaryCanvasMaskToken(token: string | null | undefined): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

async function cleanupExpiredMasks(): Promise<void> {
  const directory = temporaryMaskDirectory();
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  await Promise.allSettled(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const token = entry.name.endsWith(".png") ? entry.name.slice(0, -4) : "";
      const match = TOKEN_PATTERN.exec(token);
      if (!match || now - Number(match[1]) <= MAX_MASK_AGE_MS) return;
      await unlink(path.join(directory, entry.name));
    }),
  );
}

export async function storeTemporaryCanvasMask(file: File): Promise<string> {
  const bytes = Buffer.from(await file.arrayBuffer());
  if (sniffImageMime(bytes) !== "image/png") {
    throw new ApiError({
      status: 400,
      code: "invalid_canvas_mask",
      message: "Canvas mask must be a PNG image.",
      retryable: false,
    });
  }

  const token = `cm_${Date.now()}_${randomUUID().replaceAll("-", "")}`;
  await mkdir(temporaryMaskDirectory(), { recursive: true, mode: 0o700 });
  await cleanupExpiredMasks();
  await writeFile(temporaryMaskPath(token), bytes, { flag: "wx", mode: 0o600 });
  const expiry = setTimeout(() => {
    void deleteTemporaryCanvasMask(token).catch(() => {});
  }, MAX_MASK_AGE_MS);
  expiry.unref();
  return token;
}

export async function readTemporaryCanvasMask(token: string): Promise<Buffer> {
  const filePath = temporaryMaskPath(token);
  const match = TOKEN_PATTERN.exec(token)!;
  const createdAt = Number(match[1]);
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > MAX_MASK_AGE_MS) {
    await deleteTemporaryCanvasMask(token);
    throw new ApiError({
      status: 410,
      code: "canvas_mask_expired",
      message: "Canvas mask expired. Draw the mask again.",
      retryable: false,
    });
  }
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new ApiError({
        status: 404,
        code: "canvas_mask_not_found",
        message: "Canvas mask was not found. Draw the mask again.",
        retryable: false,
      });
    }
    throw error;
  }
}

export async function deleteTemporaryCanvasMask(token: string): Promise<void> {
  try {
    await unlink(temporaryMaskPath(token));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw error;
  }
}
