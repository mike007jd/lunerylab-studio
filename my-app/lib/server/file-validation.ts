import type { Prisma } from "@prisma/client";
import sharp, { type Metadata } from "sharp";
import { prisma } from "@/lib/server/prisma";
import { ApiError } from "@/lib/server/errors";
import { getMaxUploadBytesPerFile } from "@/lib/server/env";
import { sniffImageMime } from "@/lib/server/byok-shared";

const MAX_IMAGE_DIMENSION = 8192;

type PrismaTransactionClient = Prisma.TransactionClient;

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function isImageMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/");
}

export function isImageAssetLike(asset: {
  modality?: string | null;
  mimeType?: string | null;
}): boolean {
  return asset.modality === "IMAGE" && isImageMimeType(asset.mimeType);
}

export function assertRequestContentLength(headers: Headers, maxBytes: number) {
  const contentLength = headers.get("content-length");
  if (!contentLength) return;

  const parsed = Number(contentLength);
  if (!Number.isFinite(parsed) || parsed <= maxBytes) return;

  throw new ApiError({
    status: 413,
    code: "request_too_large",
    message: `Request body exceeds the ${maxBytes} byte limit.`,
    retryable: false,
  });
}

export async function validateFiles(
  files: File[],
  {
    maxFiles,
    allowedMimeTypes = ALLOWED_IMAGE_MIME_TYPES,
    maxBytesPerFile = getMaxUploadBytesPerFile(),
    maxDimension = MAX_IMAGE_DIMENSION,
  }: {
    maxFiles: number;
    allowedMimeTypes?: ReadonlySet<string>;
    maxBytesPerFile?: number;
    maxDimension?: number;
  },
) {
  if (files.length > maxFiles) {
    throw new ApiError({
      status: 400,
      code: "too_many_files",
      message: `Too many files. Maximum allowed is ${maxFiles}.`,
      retryable: false,
    });
  }

  for (const file of files) {
    if (file.size > maxBytesPerFile) {
      throw new ApiError({
        status: 413,
        code: "file_too_large",
        message: `File exceeds the ${maxBytesPerFile} byte limit.`,
        retryable: false,
      });
    }

    // Browser MIME (`file.type`) is a hint set by the OS file picker — easy to
    // spoof. Read the head of the file and sniff the magic bytes; the sniffed
    // MIME is the one we trust for storage and dispatch.
    const buffer = Buffer.from(await file.arrayBuffer());
    const sniffedMime = sniffImageMime(buffer);
    if (!sniffedMime || !allowedMimeTypes.has(sniffedMime)) {
      throw new ApiError({
        status: 400,
        code: "unsupported_file_type",
        message: `Unsupported file type: ${sniffedMime ?? file.type ?? "unknown"}.`,
        retryable: false,
      });
    }

    // Decompression-bomb guard: a 1 MB PNG can claim to be 100k × 100k.
    // sharp.metadata() reads the header only (cheap) and reports the declared
    // dimensions; reject anything bigger than maxDimension on either axis.
    let metadata: Metadata;
    try {
      metadata = await sharp(buffer).metadata();
    } catch {
      throw new ApiError({
        status: 400,
        code: "unsupported_file_type",
        message: `File is not a decodable image.`,
        retryable: false,
      });
    }
    // sharp.metadata() either succeeds with width/height populated for the
    // allowed image MIMEs (PNG/JPEG/WebP all encode dimensions in their
    // header) or throws above. The width<=0 / height<=0 fallback was dead.
    const { width = 0, height = 0 } = metadata;
    if (width > maxDimension || height > maxDimension) {
      throw new ApiError({
        status: 413,
        code: "image_too_large",
        message: `Image ${width}×${height} exceeds the ${maxDimension}×${maxDimension} limit.`,
        retryable: false,
      });
    }
  }
}

/**
 * Run multi-row asset writes in a single Prisma transaction so asset rows,
 * job terminal state, and related canvas mutations stay atomic.
 */
export async function withAssetWriteTransaction<T>(
  write: (tx: PrismaTransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(write);
}
