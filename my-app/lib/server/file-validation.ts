import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Metadata } from "sharp";
import { prisma } from "@/lib/server/prisma";
import { ApiError } from "@/lib/server/errors";
import { getMaxUploadBytesPerFile } from "@/lib/server/env";
import { sniffImageMime } from "@/lib/server/byok-shared";
import { safeSharp } from "@/lib/server/image-safety";

const MAX_IMAGE_DIMENSION = 8192;

type PrismaTransactionClient = Prisma.TransactionClient;

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/** One-read prepared image: bytes, trusted MIME, dimensions, and content hash. */
export interface PreparedImage {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  sha256: string;
  byteSize: number;
}

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

async function prepareImageFile(
  file: File,
  {
    allowedMimeTypes,
    maxBytesPerFile,
    maxDimension,
  }: {
    allowedMimeTypes: ReadonlySet<string>;
    maxBytesPerFile: number;
    maxDimension: number;
  },
): Promise<PreparedImage> {
  if (file.size > maxBytesPerFile) {
    throw new ApiError({
      status: 413,
      code: "file_too_large",
      message: `File exceeds the ${maxBytesPerFile} byte limit.`,
      retryable: false,
    });
  }

  // Browser MIME (`file.type`) is a hint set by the OS file picker — easy to
  // spoof. Read once; sniff magic bytes; reuse the same Buffer for fingerprint,
  // storage, and provider input.
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

  let metadata: Metadata;
  try {
    // metadata() does not decode compressed pixels (sharp 0.35). stats() does;
    // animated mode makes the validation pipeline decode every frame.
    metadata = await safeSharp(buffer, { failOn: "warning" }).metadata();
    await safeSharp(buffer, { failOn: "warning", animated: true }).stats();
  } catch {
    throw new ApiError({
      status: 400,
      code: "unsupported_file_type",
      message: `File is not a decodable image.`,
      retryable: false,
    });
  }
  // Match the dimensions browsers and storage use for EXIF-rotated photos.
  // Using the raw encoded dimensions here would swap width/height for phone
  // images with orientations 5-8 and persist inconsistent metadata.
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new ApiError({
      status: 400,
      code: "unsupported_file_type",
      message: "File does not contain valid image dimensions.",
      retryable: false,
    });
  }
  if (width > maxDimension || height > maxDimension) {
    throw new ApiError({
      status: 413,
      code: "image_too_large",
      message: `Image ${width}×${height} exceeds the ${maxDimension}×${maxDimension} limit.`,
      retryable: false,
    });
  }

  return {
    buffer,
    mimeType: sniffedMime,
    width,
    height,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    byteSize: buffer.byteLength,
  };
}

/**
 * Validate and prepare uploaded images with a single read per file.
 * Returns prepared images carrying Buffer, trusted MIME, dimensions, and SHA-256.
 */
export async function prepareImageFiles(
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
): Promise<PreparedImage[]> {
  if (files.length > maxFiles) {
    throw new ApiError({
      status: 400,
      code: "too_many_files",
      message: `Too many files. Maximum allowed is ${maxFiles}.`,
      retryable: false,
    });
  }

  const prepared: PreparedImage[] = [];
  for (const file of files) {
    prepared.push(
      await prepareImageFile(file, { allowedMimeTypes, maxBytesPerFile, maxDimension }),
    );
  }
  return prepared;
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
