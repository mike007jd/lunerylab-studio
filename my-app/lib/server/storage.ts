import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { lookup as lookupMime } from "mime-types";
import { ApiError } from "@/lib/server/errors";
import { sniffImageMime } from "@/lib/server/byok-shared";
import type { PreparedImage } from "@/lib/server/file-validation";
import { assertImageByteSize, safeSharp } from "@/lib/server/image-safety";
import { extensionFromMime } from "@/lib/mime";
import { sniff3dModelMime, sniffVideoMime } from "@/lib/media-sniff";
import { luneryMediaDir } from "@/lib/server/lunery-profile";

export interface StoredFile {
  storagePath: string;
  absolutePath?: string;
  byteSize: number;
  mimeType: string;
}

export interface StoredImageFile extends StoredFile {
  width: number;
  height: number;
}

export interface StoredFileMetadata {
  byteSize: number;
  mimeType: string;
}

export interface StoredFileStream extends StoredFileMetadata {
  stream: ReadableStream<Uint8Array>;
}

const STORAGE_BUCKETS = new Set(["uploads", "generated"]);
// A per-project subfolder name (a project id / cuid). Kept conservative so the
// relaxed 3-segment path can never become a traversal vector.
const SAFE_SUBDIR = /^[A-Za-z0-9_-]+$/;

async function localFs() {
  return import("node:fs/promises");
}

async function localCreateReadStream(
  filePath: string,
  range?: { start: number; end: number },
) {
  const fs = await import("node:fs");
  return fs.createReadStream(filePath, range);
}

function storageRootPath() {
  return luneryMediaDir();
}

function normalizeRuntimeRoot(root: string): string {
  const normalized = path.normalize(root);
  const filesystemRoot = path.parse(normalized).root;
  return normalized === filesystemRoot ? filesystemRoot : normalized.replace(/[\\/]+$/, "");
}

function joinRuntimePath(root: string, ...parts: string[]) {
  const normalizedRoot = normalizeRuntimeRoot(root);
  if (parts.length === 0) return normalizedRoot;
  const separator = normalizedRoot.endsWith(path.sep) ? "" : path.sep;
  return `${normalizedRoot}${separator}${parts.join(path.sep)}`;
}

/**
 * List every stored file under the local storage root as bucket-relative POSIX
 * paths (e.g. `generated/abc.png`, `uploads/{projectId}/x.jpg`) — the same shape
 * as an asset's `storagePath`.
 */
export async function listStoredRelativePaths(): Promise<string[]> {
  const root = storageRootPath();
  const fs = await localFs();
  const out: string[] = [];
  for (const bucket of STORAGE_BUCKETS) {
    const bucketDir = joinRuntimePath(root, bucket);
    await walkFiles(fs, bucketDir, bucket, out);
  }
  return out;
}

async function walkFiles(
  fs: typeof import("node:fs/promises"),
  dir: string,
  relPrefix: string,
  out: string[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkFiles(fs, joinRuntimePath(dir, entry.name), rel, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(rel);
    }
  }
}

export function resolveStoragePath(storagePath: string) {
  const root = storageRootPath();
  // A backslash is a path separator on Windows but an ordinary character to
  // path.posix.normalize. Reject it before validation so a value such as
  // `generated/..\\..\\file` cannot pass POSIX checks and escape at fs time.
  if (storagePath.includes("\\")) {
    throw new Error("Invalid storage path");
  }
  const normalized = path.posix.normalize(storagePath);
  const parts = normalized.split("/");
  // Allow the flat `bucket/file` form (legacy + unassigned) AND the
  // project-scoped `bucket/{projectId}/file` form. Every non-bucket segment
  // must be a plain name (no empty/"."/".."), the optional middle segment must
  // be an id-safe token, and the input must not be absolute.
  const segmentsOk =
    (parts.length === 2 || parts.length === 3) &&
    STORAGE_BUCKETS.has(parts[0]!) &&
    parts.slice(1).every((seg) => Boolean(seg) && seg !== "." && seg !== "..") &&
    (parts.length !== 3 || SAFE_SUBDIR.test(parts[1]!));
  if (!segmentsOk || path.isAbsolute(storagePath)) {
    throw new Error("Invalid storage path");
  }

  const resolved = joinRuntimePath(root, ...parts);
  // Defense in depth: the resolved path must stay inside the storage root even
  // if the segment checks above are ever loosened.
  const normalizedRoot = normalizeRuntimeRoot(root);
  const relative = path.relative(normalizedRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Invalid storage path");
  }
  return resolved;
}

// sniffImageMime imported from `byok-shared.ts` — single MIME-table for the
// whole repo. Returns null on unknown bytes; callers decide their default.

export async function ensureStorage() {
  const root = storageRootPath();
  const fs = await localFs();
  await fs.mkdir(path.join(root, "uploads"), { recursive: true });
  await fs.mkdir(path.join(root, "generated"), { recursive: true });
  return root;
}

function storedFileNotFound(): never {
  throw new ApiError({
    status: 404,
    code: "stored_file_not_found",
    message: "Stored asset file was not found.",
    retryable: false,
  });
}

export interface WrittenReference extends StoredImageFile {
  buffer: Buffer;
}

async function readImageDimensions(
  bytes: Buffer,
  error: { status: number; code: string; message: string; retryable: boolean },
  options?: { decodePixels?: boolean },
): Promise<{ width: number; height: number }> {
  try {
    // autoOrient reports the EXIF-corrected size — phone photos carry rotation
    // flags, and browsers render the rotated result, so the raw encoded
    // width/height would swap the aspect ratio for orientations 5-8.
    const metadata = await safeSharp(bytes, { failOn: "warning" }).metadata();
    if (options?.decodePixels) {
      // metadata() does not decode compressed pixels. Force a full-frame decode
      // (including later animated WebP pages) before persisting provider bytes.
      await safeSharp(bytes, { failOn: "warning", animated: true }).stats();
    }
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
      throw new Error("Image dimensions are missing or invalid.");
    }
    return { width, height };
  } catch (caught) {
    if (caught instanceof ApiError) throw caught;
    throw new ApiError(error);
  }
}

/**
 * Persist a reference image. Prefer a PreparedImage from prepareImageFiles so
 * storage reuses the already-validated bytes (one-read path).
 */
export async function writeReferenceFile(
  file: PreparedImage,
): Promise<WrittenReference> {
  const { buffer, mimeType, width, height } = file;
  const ext = extensionFromMime(mimeType);
  const storagePath = path.posix.join("uploads", `${Date.now()}-${randomUUID()}.${ext}`);

  await ensureStorage();
  const absolutePath = resolveStoragePath(storagePath);

  const fs = await localFs();
  await fs.writeFile(absolutePath, buffer);

  return {
    storagePath,
    absolutePath,
    byteSize: buffer.byteLength,
    mimeType,
    width,
    height,
    buffer,
  };
}

async function writeGeneratedFile({
  bytes,
  mimeType,
  projectId,
}: {
  bytes: Buffer;
  mimeType: string;
  projectId?: string | null;
}): Promise<StoredFile> {
  const ext = extensionFromMime(mimeType);
  const fileName = `${Date.now()}-${randomUUID()}.${ext}`;
  // Project-scoped outputs live in a per-project subfolder so a project's files
  // sit together on disk (browsable via "Reveal in Finder"); unassigned outputs
  // stay in the flat generated/ root.
  const storagePath =
    projectId && SAFE_SUBDIR.test(projectId)
      ? path.posix.join("generated", projectId, fileName)
      : path.posix.join("generated", fileName);

  await ensureStorage();
  const absolutePath = resolveStoragePath(storagePath);

  const fs = await localFs();
  // ensureStorage only creates the bucket roots — make the per-project subdir.
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, bytes);

  return {
    storagePath,
    absolutePath,
    byteSize: bytes.byteLength,
    mimeType,
  };
}

export async function restoreStoredFile({
  storagePath,
  bytes,
  mimeType,
}: {
  storagePath: string;
  bytes: Buffer;
  mimeType: string;
}): Promise<StoredFile> {
  await ensureStorage();
  const absolutePath = resolveStoragePath(storagePath);
  const fs = await localFs();
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, bytes);

  return {
    storagePath,
    absolutePath,
    byteSize: bytes.byteLength,
    mimeType,
  };
}

async function assertGeneratedImage(
  bytes: Buffer,
): Promise<{ mimeType: string; width: number; height: number }> {
  try {
    assertImageByteSize(bytes, "generated image");
  } catch {
    throw new ApiError({
      status: 502,
      code: "invalid_generated_image",
      message: "Provider returned an image that exceeds the allowed size.",
      retryable: true,
    });
  }

  const sniffedMime = sniffImageMime(bytes);
  if (!sniffedMime) {
    throw new ApiError({
      status: 502,
      code: "invalid_generated_image",
      message: "Provider returned data that is not a supported image.",
      retryable: true,
    });
  }

  const dimensions = await readImageDimensions(
    bytes,
    {
      status: 502,
      code: "invalid_generated_image",
      message: "Provider returned an image that could not be decoded.",
      retryable: true,
    },
    { decodePixels: true },
  );

  return { mimeType: sniffedMime, ...dimensions };
}

// Generated media MIME is always derived from bytes; callers never supply a
// provider-declared type that could disagree with the stored content.
export async function writeGeneratedImage({
  bytes,
  projectId,
}: {
  bytes: Buffer;
  projectId?: string | null;
}): Promise<StoredImageFile> {
  const image = await assertGeneratedImage(bytes);
  const stored = await writeGeneratedFile({ bytes, mimeType: image.mimeType, projectId });
  return { ...stored, ...image };
}

function assertGeneratedVideo(bytes: Buffer): string {
  const sniffed = sniffVideoMime(bytes);
  if (!sniffed) {
    throw new ApiError({
      status: 502,
      code: "invalid_generated_video",
      message: "Provider returned data that is not a supported video container.",
      retryable: true,
    });
  }
  return sniffed;
}

function assertGenerated3dModel(bytes: Buffer): string {
  const sniffed = sniff3dModelMime(bytes);
  if (!sniffed) {
    throw new ApiError({
      status: 502,
      code: "invalid_generated_model",
      message: "Provider returned data that is not a supported 3D model format.",
      retryable: true,
    });
  }
  return sniffed;
}

export async function writeGeneratedVideo(
  bytes: Buffer,
  projectId?: string | null,
): Promise<StoredFile> {
  const mimeType = assertGeneratedVideo(bytes);
  return writeGeneratedFile({ bytes, mimeType, projectId });
}

export async function writeGenerated3dModel(
  bytes: Buffer,
  projectId?: string | null,
): Promise<StoredFile> {
  const mimeType = assertGenerated3dModel(bytes);
  return writeGeneratedFile({ bytes, mimeType, projectId });
}

export async function readStoredFile(storagePath: string) {
  const resolved = resolveStoragePath(storagePath);
  let file: Buffer;
  try {
    const fs = await localFs();
    file = await fs.readFile(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      storedFileNotFound();
    }
    throw error;
  }
  const mimeType = (lookupMime(resolved) || "application/octet-stream") as string;
  return {
    file,
    mimeType,
  };
}

export async function deleteStoredFile(storagePath: string) {
  const resolved = resolveStoragePath(storagePath);

  try {
    const fs = await localFs();
    const metadata = await fs.lstat(resolved);
    if (metadata.isDirectory()) throw new Error("Refusing to delete a storage directory as a file.");
    await assertStoredFileParent(resolved);
    await fs.unlink(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

const STAGED_DELETE_SUFFIX = ".lunery-purge";

async function assertStoredFileParent(absolutePath: string): Promise<void> {
  const fs = await localFs();
  const [root, parent] = await Promise.all([
    fs.realpath(storageRootPath()),
    fs.realpath(path.dirname(absolutePath)),
  ]);
  const relative = path.relative(root, parent);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Stored file parent escapes the media root.");
  }
}

export interface StagedStoredFileDeletion {
  storagePath: string;
  stagedStoragePath: string;
  hadFile: boolean;
}

function stagedDeleteStoragePath(storagePath: string): string {
  return `${storagePath}${STAGED_DELETE_SUFFIX}`;
}

export async function stageStoredFileDeletion(
  storagePath: string,
): Promise<StagedStoredFileDeletion> {
  const fs = await localFs();
  const resolved = resolveStoragePath(storagePath);
  const stagedStoragePath = stagedDeleteStoragePath(storagePath);
  const staged = resolveStoragePath(stagedStoragePath);
  const [originalExists, stagedExists] = await Promise.all(
    [resolved, staged].map(async (candidate) => {
      try {
        return await fs.lstat(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
        throw error;
      }
    }),
  );

  const isDeletableFile = (metadata: import("node:fs").Stats) =>
    metadata.isFile() || metadata.isSymbolicLink();
  if (
    (originalExists && !isDeletableFile(originalExists))
    || (stagedExists && !isDeletableFile(stagedExists))
  ) {
    throw new Error("Refusing to stage a non-regular storage file.");
  }
  if (originalExists && stagedExists) {
    throw new Error("A staged storage deletion conflicts with the current file.");
  }
  if (stagedExists) {
    await assertStoredFileParent(staged);
    return { storagePath, stagedStoragePath, hadFile: true };
  }
  if (!originalExists) {
    return { storagePath, stagedStoragePath, hadFile: false };
  }

  await assertStoredFileParent(resolved);
  await fs.rename(resolved, staged);
  return { storagePath, stagedStoragePath, hadFile: true };
}

export async function rollbackStoredFileDeletion(
  stage: StagedStoredFileDeletion,
): Promise<void> {
  if (!stage.hadFile) return;
  const fs = await localFs();
  const resolved = resolveStoragePath(stage.storagePath);
  const staged = resolveStoragePath(stage.stagedStoragePath);
  try {
    await fs.lstat(staged);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw error;
  }
  try {
    await fs.lstat(resolved);
    throw new Error("Cannot restore a staged deletion over a replacement file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
  await assertStoredFileParent(staged);
  await fs.rename(staged, resolved);
}

export async function commitStoredFileDeletion(
  stage: StagedStoredFileDeletion,
): Promise<void> {
  if (!stage.hadFile) return;
  await deleteStoredFile(stage.stagedStoragePath);
}

export async function reconcileStagedStoredFileDeletions(
  referencedPaths: ReadonlySet<string>,
): Promise<void> {
  const stagedPaths = (await listStoredRelativePaths()).filter((storagePath) =>
    storagePath.endsWith(STAGED_DELETE_SUFFIX),
  );
  for (const stagedStoragePath of stagedPaths) {
    const storagePath = stagedStoragePath.slice(0, -STAGED_DELETE_SUFFIX.length);
    const stage = { storagePath, stagedStoragePath, hadFile: true };
    if (referencedPaths.has(storagePath)) {
      await rollbackStoredFileDeletion(stage);
    } else {
      await commitStoredFileDeletion(stage);
    }
  }
}

/**
 * Write several files in parallel as an all-or-nothing batch for cleanup: if any
 * write rejects, the ones that already landed are deleted so a partial failure
 * (e.g. the 2nd of 3 writes throwing) can't orphan files on disk. Rethrows the
 * first rejection after cleanup.
 */
export async function writeFilesOrCleanup<T extends { storagePath: string }>(
  writes: Array<() => Promise<T>>,
): Promise<T[]> {
  const settled = await Promise.allSettled(writes.map((write) => write()));
  const written = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure) {
    await Promise.allSettled(written.map((file) => deleteStoredFile(file.storagePath)));
    throw failure.reason;
  }
  return written;
}

export async function getStoredFileMetadata(storagePath: string): Promise<StoredFileMetadata> {
  const resolved = resolveStoragePath(storagePath);
  try {
    const fs = await localFs();
    const fileInfo = await fs.stat(resolved);
    return {
      byteSize: fileInfo.size,
      mimeType: (lookupMime(resolved) || "application/octet-stream") as string,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      storedFileNotFound();
    }
    throw error;
  }
}

export async function streamStoredFile(
  storagePath: string,
  range?: { start: number; end: number },
): Promise<StoredFileStream> {
  const resolved = resolveStoragePath(storagePath);
  const metadata = await getStoredFileMetadata(storagePath);
  const fileStream = await localCreateReadStream(resolved, range);
  const stream = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>;
  return {
    ...metadata,
    stream,
  };
}
