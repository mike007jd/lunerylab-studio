import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
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
import { withSharedMutationLease } from "@/lib/server/workspace-operation-gate";

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
    const bucketDir = await prepareStorageBucket(bucket, { create: false });
    if (!bucketDir) continue;
    const rootReal = await fs.realpath(root);
    await walkFiles(fs, bucketDir, bucket, out, rootReal);
  }
  return out;
}

async function walkFiles(
  fs: typeof import("node:fs/promises"),
  dir: string,
  relPrefix: string,
  out: string[],
  rootReal: string,
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    const directory = await fs.lstat(dir);
    if (directory.isSymbolicLink()) {
      throw new Error("Storage path component is a symlink.");
    }
    if (!directory.isDirectory()) {
      throw new Error("Storage path component is not a directory.");
    }
    assertRealPathInsideRoot(rootReal, await fs.realpath(dir));
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkFiles(fs, joinRuntimePath(dir, entry.name), rel, out, rootReal);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(rel);
    }
  }
}

function storagePathSegments(storagePath: string): string[] {
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
  return parts;
}

export function resolveStoragePath(storagePath: string) {
  const root = storageRootPath();
  const parts = storagePathSegments(storagePath);
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

function assertRealPathInsideRoot(rootReal: string, candidateReal: string): void {
  const relative = path.relative(rootReal, candidateReal);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Stored path escapes the media root.");
  }
}

async function prepareStorageBucket(
  bucket: string,
  options: { create: boolean },
): Promise<string | null> {
  const fs = await localFs();
  const root = normalizeRuntimeRoot(storageRootPath());
  let rootMetadata: import("node:fs").Stats | null = null;
  try {
    rootMetadata = await fs.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
  // Inspect an existing root before mkdir. mkdir({recursive:true}) may follow a
  // root symlink and create directories in its target before the later lstat
  // rejects it.
  if (!rootMetadata) {
    if (!options.create) return null;
    await fs.mkdir(root, { recursive: true });
    rootMetadata = await fs.lstat(root);
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Storage root must be a real directory.");
  }
  const rootReal = await fs.realpath(root);
  const bucketDir = joinRuntimePath(root, bucket);
  let bucketMetadata: import("node:fs").Stats | null = null;
  try {
    bucketMetadata = await fs.lstat(bucketDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
  if (!bucketMetadata) {
    if (!options.create) return null;
    try {
      await fs.mkdir(bucketDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error;
    }
    bucketMetadata = await fs.lstat(bucketDir);
  }
  if (bucketMetadata.isSymbolicLink()) {
    throw new Error("Storage path component is a symlink.");
  }
  if (!bucketMetadata.isDirectory()) {
    throw new Error("Storage path component is not a directory.");
  }
  assertRealPathInsideRoot(rootReal, await fs.realpath(bucketDir));
  return bucketDir;
}

/**
 * Canonical no-follow containment: walk every path component with lstat and
 * reject symlink bucket/project/intermediate/final components. Lexical
 * resolveStoragePath alone is not sufficient.
 */
async function resolveCanonicalStoragePath(
  storagePath: string,
  options: {
    /**
     * For writes: allow the final file and any trailing project subdirectory
     * that does not exist yet. The nearest existing ancestor must still be a
     * real contained directory (no symlink escape).
     */
    allowMissingLeaf?: boolean;
    /** Delete may unlink a final symlink; read/write/stream must reject it. */
    allowFinalSymlink?: boolean;
  } = {},
): Promise<string> {
  const fs = await localFs();
  const parts = storagePathSegments(storagePath);
  const root = storageRootPath();
  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new Error("Storage root does not exist.");
    }
    throw error;
  }

  let current = normalizeRuntimeRoot(root);
  for (let index = 0; index < parts.length; index += 1) {
    const segment = parts[index]!;
    current = joinRuntimePath(current, segment);
    const isFinal = index === parts.length - 1;
    let metadata: import("node:fs").Stats;
    try {
      metadata = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
      if (!options.allowMissingLeaf) {
        if (isFinal) storedFileNotFound();
        throw new Error("Storage path component is missing.");
      }
      // Missing project dir or final file: parent must be a real contained dir.
      const parentReal = await fs.realpath(path.dirname(current));
      assertRealPathInsideRoot(rootReal, parentReal);
      return joinRuntimePath(root, ...parts);
    }
    if (metadata.isSymbolicLink()) {
      if (isFinal && options.allowFinalSymlink) {
        const parentReal = await fs.realpath(path.dirname(current));
        assertRealPathInsideRoot(rootReal, parentReal);
        return current;
      }
      throw new Error("Storage path component is a symlink.");
    }
    if (!isFinal && !metadata.isDirectory()) {
      throw new Error("Storage path component is not a directory.");
    }
  }

  const parentReal = await fs.realpath(path.dirname(current));
  assertRealPathInsideRoot(rootReal, parentReal);
  return current;
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

interface StoragePathIdentity {
  device: bigint;
  inode: bigint;
}

interface CanonicalOpenGuard {
  directories: Array<{ absolutePath: string; identity: StoragePathIdentity }>;
  finalIdentity: StoragePathIdentity | null;
  rootReal: string;
}

function bigintIdentity(metadata: import("node:fs").BigIntStats): StoragePathIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function samePathIdentity(left: StoragePathIdentity, right: StoragePathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function guardedDirectoryPaths(absolutePath: string): string[] {
  const root = normalizeRuntimeRoot(storageRootPath());
  const relative = path.relative(root, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Stored path escapes the media root.");
  }
  const relativeParts = relative.split(path.sep);
  // Reuse the public storage-path grammar so only root/bucket/optional-project
  // directories can participate in the final open guard.
  storagePathSegments(relativeParts.join("/"));
  const directories = [root];
  let current = root;
  for (const segment of relativeParts.slice(0, -1)) {
    current = joinRuntimePath(current, segment);
    directories.push(current);
  }
  return directories;
}

async function captureCanonicalOpenGuard(
  absolutePath: string,
  allowMissingFinal: boolean,
): Promise<CanonicalOpenGuard> {
  const fs = await localFs();
  const directoryPaths = guardedDirectoryPaths(absolutePath);
  const rootPath = directoryPaths[0]!;
  const rootMetadata = await fs.lstat(rootPath, { bigint: true });
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Storage root must be a real directory.");
  }
  const rootReal = await fs.realpath(rootPath);
  const directories: CanonicalOpenGuard["directories"] = [];
  for (const directoryPath of directoryPaths) {
    const metadata = await fs.lstat(directoryPath, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Storage path component is a symlink.");
    }
    assertRealPathInsideRoot(rootReal, await fs.realpath(directoryPath));
    directories.push({ absolutePath: directoryPath, identity: bigintIdentity(metadata) });
  }

  let finalIdentity: StoragePathIdentity | null = null;
  try {
    const finalMetadata = await fs.lstat(absolutePath, { bigint: true });
    if (finalMetadata.isSymbolicLink()) {
      throw new Error("Storage path component is a symlink.");
    }
    if (!finalMetadata.isFile()) {
      throw new Error("Stored path is not a regular file.");
    }
    finalIdentity = bigintIdentity(finalMetadata);
  } catch (error) {
    if (
      allowMissingFinal
      && (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ) {
      finalIdentity = null;
    } else {
      throw error;
    }
  }
  return { directories, finalIdentity, rootReal };
}

async function verifyCanonicalOpenGuard(
  guard: CanonicalOpenGuard,
  absolutePath: string,
  handle: import("node:fs/promises").FileHandle,
): Promise<void> {
  const fs = await localFs();
  await verifyCanonicalDirectories(guard);

  const [opened, currentFinal] = await Promise.all([
    handle.stat({ bigint: true }),
    fs.lstat(absolutePath, { bigint: true }),
  ]);
  if (!opened.isFile() || currentFinal.isSymbolicLink() || !currentFinal.isFile()) {
    throw new Error("Stored path is not a stable regular file.");
  }
  const openedIdentity = bigintIdentity(opened);
  const currentIdentity = bigintIdentity(currentFinal);
  if (!samePathIdentity(openedIdentity, currentIdentity)) {
    throw new Error("Storage path changed during final open.");
  }
  if (guard.finalIdentity && !samePathIdentity(guard.finalIdentity, openedIdentity)) {
    throw new Error("Storage file changed during final open.");
  }
}

async function verifyCanonicalDirectories(guard: CanonicalOpenGuard): Promise<void> {
  const fs = await localFs();
  for (const expected of guard.directories) {
    const current = await fs.lstat(expected.absolutePath, { bigint: true });
    if (
      current.isSymbolicLink()
      || !current.isDirectory()
      || !samePathIdentity(expected.identity, bigintIdentity(current))
    ) {
      throw new Error("Storage path changed during final open.");
    }
    assertRealPathInsideRoot(guard.rootReal, await fs.realpath(expected.absolutePath));
  }
}

export const __storageTestHooks = {
  beforeFinalOpen: null as null | ((absolutePath: string) => Promise<void> | void),
};

async function openFinalNoFollow(
  absolutePath: string,
  flags: number,
  mode?: number,
): Promise<import("node:fs/promises").FileHandle> {
  const fs = await localFs();
  let handle: import("node:fs/promises").FileHandle | null = null;
  try {
    // Node does not expose openat(2), and macOS /dev/fd directory paths cannot
    // address children. Revalidate root/bucket/project immediately before the
    // open, then compare every directory and final-file dev/ino again before
    // any read, truncate, or write. O_NOFOLLOW remains the atomic final-link
    // guard on macOS/Linux. On platforms without it (notably Windows), the
    // post-open lstat/fstat identity check is fail-closed but cannot claim the
    // same kernel-level atomicity as openat.
    const guard = await captureCanonicalOpenGuard(
      absolutePath,
      (flags & fsConstants.O_CREAT) !== 0,
    );
    if (process.env.NODE_ENV === "test" && __storageTestHooks.beforeFinalOpen) {
      await __storageTestHooks.beforeFinalOpen(absolutePath);
    }
    // Recheck after the deterministic race hook and immediately before open.
    // A hostile component swap detected here cannot create/truncate anything.
    await verifyCanonicalDirectories(guard);
    handle = await fs.open(absolutePath, flags | noFollowFlag(), mode);
    await verifyCanonicalOpenGuard(guard, absolutePath, handle);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ELOOP") {
      throw new Error("Storage path component is a symlink.");
    }
    throw error;
  }
}

async function assertRegularFileHandle(
  handle: import("node:fs/promises").FileHandle,
): Promise<import("node:fs").Stats> {
  const metadata = await handle.stat();
  if (!metadata.isFile()) {
    throw new Error("Stored path is not a regular file.");
  }
  return metadata;
}

async function writeNewFileNoFollow(absolutePath: string, bytes: Buffer): Promise<void> {
  const handle = await openFinalNoFollow(
    absolutePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    await assertRegularFileHandle(handle);
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function replaceFileNoFollow(absolutePath: string, bytes: Buffer): Promise<void> {
  const handle = await openFinalNoFollow(
    absolutePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT,
    0o600,
  );
  try {
    await assertRegularFileHandle(handle);
    await handle.truncate(0);
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

// sniffImageMime imported from `byok-shared.ts` — single MIME-table for the
// whole repo. Returns null on unknown bytes; callers decide their default.

export async function ensureStorage() {
  const root = storageRootPath();
  for (const bucket of STORAGE_BUCKETS) {
    await prepareStorageBucket(bucket, { create: true });
  }
  return root;
}

/**
 * Create and resolve one project-scoped storage directory without following
 * symlink components. Callers receive the canonical contained directory, and
 * the whole create/verify sequence participates in the workspace mutation
 * gate so restore cannot swap the media root underneath it.
 */
export async function ensureStorageSubdirectory(storageDirectoryPath: string): Promise<string> {
  return withSharedMutationLease(async () => {
    const probePath = `${storageDirectoryPath}/.lunery-directory-probe`;
    const parts = storagePathSegments(probePath);
    if (parts.length !== 3) {
      throw new Error("Invalid storage directory path");
    }

    await ensureStorage();
    const absoluteProbe = await resolveCanonicalStoragePath(probePath, {
      allowMissingLeaf: true,
    });
    const directory = path.dirname(absoluteProbe);
    await ensureContainedDirectory(directory);

    const fs = await localFs();
    const rootReal = await fs.realpath(storageRootPath());
    const metadata = await fs.lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Storage path component is a symlink.");
    }
    const directoryReal = await fs.realpath(directory);
    assertRealPathInsideRoot(rootReal, directoryReal);
    return directoryReal;
  });
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
  return withSharedMutationLease(async () => {
    const { buffer, mimeType, width, height } = file;
    const ext = extensionFromMime(mimeType);
    const storagePath = path.posix.join("uploads", `${Date.now()}-${randomUUID()}.${ext}`);

    await ensureStorage();
    const absolutePath = await resolveCanonicalStoragePath(storagePath, {
      allowMissingLeaf: true,
    });

    await writeNewFileNoFollow(absolutePath, buffer);

    return {
      storagePath,
      absolutePath,
      byteSize: buffer.byteLength,
      mimeType,
      width,
      height,
      buffer,
    };
  });
}

async function ensureContainedDirectory(absoluteDir: string): Promise<void> {
  const fs = await localFs();
  const root = normalizeRuntimeRoot(storageRootPath());
  const rootReal = await fs.realpath(root);
  const normalizedDir = normalizeRuntimeRoot(absoluteDir);
  if (normalizedDir === normalizeRuntimeRoot(root)) {
    assertRealPathInsideRoot(rootReal, rootReal);
    return;
  }
  let metadata: import("node:fs").Stats | null = null;
  try {
    metadata = await fs.lstat(normalizedDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
  if (metadata) {
    if (metadata.isSymbolicLink()) {
      throw new Error("Storage path component is a symlink.");
    }
    if (!metadata.isDirectory()) {
      throw new Error("Storage path component is not a directory.");
    }
    const dirReal = await fs.realpath(normalizedDir);
    assertRealPathInsideRoot(rootReal, dirReal);
    return;
  }
  await ensureContainedDirectory(path.dirname(normalizedDir));
  try {
    await fs.mkdir(normalizedDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error;
  }
  const created = await fs.lstat(normalizedDir);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error("Storage path component is a symlink.");
  }
  const createdReal = await fs.realpath(normalizedDir);
  assertRealPathInsideRoot(rootReal, createdReal);
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
  return withSharedMutationLease(async () => {
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
    const absolutePath = await resolveCanonicalStoragePath(storagePath, {
      allowMissingLeaf: true,
    });

    // ensureStorage only creates the bucket roots — make the per-project subdir
    // with lstat/recheck. Node does not expose openat for intermediate path
    // descriptors, so final-component O_NOFOLLOW below is the atomic boundary.
    await ensureContainedDirectory(path.dirname(absolutePath));
    await writeNewFileNoFollow(absolutePath, bytes);

    return {
      storagePath,
      absolutePath,
      byteSize: bytes.byteLength,
      mimeType,
    };
  });
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
  return withSharedMutationLease(async () => {
    await ensureStorage();
    const absolutePath = await resolveCanonicalStoragePath(storagePath, {
      allowMissingLeaf: true,
    });
    await ensureContainedDirectory(path.dirname(absolutePath));
    await replaceFileNoFollow(absolutePath, bytes);

    return {
      storagePath,
      absolutePath,
      byteSize: bytes.byteLength,
      mimeType,
    };
  });
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
  const resolved = await resolveCanonicalStoragePath(storagePath);
  let file: Buffer;
  let handle: import("node:fs/promises").FileHandle | null = null;
  try {
    handle = await openFinalNoFollow(resolved, fsConstants.O_RDONLY);
    await assertRegularFileHandle(handle);
    file = await handle.readFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      storedFileNotFound();
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const mimeType = (lookupMime(resolved) || "application/octet-stream") as string;
  return {
    file,
    mimeType,
  };
}

export async function deleteStoredFile(storagePath: string) {
  return withSharedMutationLease(async () => {
    const resolved = await resolveCanonicalStoragePath(storagePath, {
      allowFinalSymlink: true,
    });

    try {
      const fs = await localFs();
      const metadata = await fs.lstat(resolved);
      if (metadata.isDirectory()) throw new Error("Refusing to delete a storage directory as a file.");
      await fs.unlink(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return;
      }
      throw error;
    }
  });
}

const STAGED_DELETE_SUFFIX = ".lunery-purge";

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
  return withSharedMutationLease(async () => {
    const fs = await localFs();
    const resolved = await resolveCanonicalStoragePath(storagePath, {
      allowMissingLeaf: true,
      allowFinalSymlink: true,
    });
    const stagedStoragePath = stagedDeleteStoragePath(storagePath);
    const staged = await resolveCanonicalStoragePath(stagedStoragePath, {
      allowMissingLeaf: true,
      allowFinalSymlink: true,
    });
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
      return { storagePath, stagedStoragePath, hadFile: true };
    }
    if (!originalExists) {
      return { storagePath, stagedStoragePath, hadFile: false };
    }

    await fs.rename(resolved, staged);
    return { storagePath, stagedStoragePath, hadFile: true };
  });
}

export async function rollbackStoredFileDeletion(
  stage: StagedStoredFileDeletion,
): Promise<void> {
  if (!stage.hadFile) return;
  return withSharedMutationLease(async () => {
    const fs = await localFs();
    const resolved = await resolveCanonicalStoragePath(stage.storagePath, {
      allowMissingLeaf: true,
      allowFinalSymlink: true,
    });
    const staged = await resolveCanonicalStoragePath(stage.stagedStoragePath, {
      allowFinalSymlink: true,
    });
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
    await fs.rename(staged, resolved);
  });
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
  return withSharedMutationLease(async () => {
    const settled = await Promise.allSettled(writes.map((write) => write()));
    const written = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) {
      await Promise.allSettled(written.map((file) => deleteStoredFile(file.storagePath)));
      throw failure.reason;
    }
    return written;
  });
}

export async function getStoredFileMetadata(storagePath: string): Promise<StoredFileMetadata> {
  const resolved = await resolveCanonicalStoragePath(storagePath);
  let handle: import("node:fs/promises").FileHandle | null = null;
  try {
    handle = await openFinalNoFollow(resolved, fsConstants.O_RDONLY);
    const fileInfo = await assertRegularFileHandle(handle);
    return {
      byteSize: fileInfo.size,
      mimeType: (lookupMime(resolved) || "application/octet-stream") as string,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      storedFileNotFound();
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function streamStoredFile(
  storagePath: string,
  range?: { start: number; end: number },
): Promise<StoredFileStream> {
  const resolved = await resolveCanonicalStoragePath(storagePath);
  let handle: import("node:fs/promises").FileHandle | null = null;
  try {
    handle = await openFinalNoFollow(resolved, fsConstants.O_RDONLY);
    const fileInfo = await assertRegularFileHandle(handle);
    const fileStream = handle.createReadStream({
      ...(range ?? {}),
      autoClose: true,
    });
    handle = null; // Stream owns and closes the descriptor.
    return {
      byteSize: fileInfo.size,
      mimeType: (lookupMime(resolved) || "application/octet-stream") as string,
      stream: Readable.toWeb(fileStream) as ReadableStream<Uint8Array>,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      storedFileNotFound();
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
