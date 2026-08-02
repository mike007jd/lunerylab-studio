import "server-only";

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { bridgeFetch, requireDesktopBridge } from "@/lib/server/desktop-bridge";
import {
  luneryConfigDir,
  luneryMediaDir,
  luneryModelsDir,
  luneryRuntimeDir,
} from "@/lib/server/lunery-profile";
import { ApiError } from "@/lib/server/errors";

export type NativeProfileRoot = "config" | "media" | "models" | "runtime";

type ProfileFsRequest =
  | { operation: "mkdir"; root: NativeProfileRoot; relative_path: string }
  | {
      operation: "write";
      root: NativeProfileRoot;
      relative_path: string;
      source_path: string;
      replace: boolean;
    }
  | {
      operation: "rename";
      root: NativeProfileRoot;
      source_relative_path: string;
      destination_relative_path: string;
      replace: boolean;
    }
  | {
      operation: "unlink";
      root: NativeProfileRoot;
      relative_path: string;
      missing_ok: boolean;
    }
  | {
      operation: "unlink-external-identity";
      absolute_path: string;
      expected_device: string;
      expected_inode: string;
      expected_size: string;
      expected_modified_at_ns: string;
    };

export const __nativeProfileFsTestHooks = {
  execute: null as null | ((request: ProfileFsRequest) => Promise<void> | void),
  sleep: null as null | ((delayMs: number) => Promise<void> | void),
};

// A 429 is emitted before the native bridge executes the mutation. Every
// logical operation also carries one request id; the native bridge caches the
// first completed result while it is alive, so an ambiguous transport retry
// with that same id can never execute the mutation twice.
const CAPACITY_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;

async function waitForCapacity(delayMs: number): Promise<void> {
  if (__nativeProfileFsTestHooks.sleep) {
    await __nativeProfileFsTestHooks.sleep(delayMs);
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function validateRelativePath(relativePath: string): string {
  if (
    !relativePath
    || relativePath.includes("\\")
    || relativePath.includes("\0")
    || path.posix.isAbsolute(relativePath)
  ) {
    throw new Error("Invalid profile-relative path.");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid profile-relative path.");
  }
  return segments.join("/");
}

function rootPath(root: NativeProfileRoot): string {
  switch (root) {
    case "config": return luneryConfigDir();
    case "media": return luneryMediaDir();
    case "models": return luneryModelsDir();
    case "runtime": return luneryRuntimeDir();
  }
}

async function assertTestProfileParents(
  rootKind: NativeProfileRoot,
  root: string,
  relativePath: string,
): Promise<void> {
  const rootMetadata = await fs.lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(
      rootKind === "media"
        ? "Storage root must be a real directory."
        : "Profile resource root must be a real directory.",
    );
  }
  let current = root;
  const parentSegments = relativePath.split("/").slice(0, -1);
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    try {
      const metadata = await fs.lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(
          rootKind === "media"
            ? "Storage path component is a symlink."
            : "Profile resource path contains a symlink.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
}

async function executeTestFallback(request: ProfileFsRequest): Promise<void> {
  if (__nativeProfileFsTestHooks.execute) {
    await __nativeProfileFsTestHooks.execute(request);
    return;
  }
  switch (request.operation) {
    case "mkdir": {
      const root = rootPath(request.root);
      await assertTestProfileParents(request.root, root, `${request.relative_path}/.mkdir-leaf`);
      await fs.mkdir(path.join(root, request.relative_path), { recursive: true });
      return;
    }
    case "write": {
      const root = rootPath(request.root);
      await assertTestProfileParents(request.root, root, request.relative_path);
      const destination = path.join(root, request.relative_path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(
        request.source_path,
        destination,
        request.replace ? 0 : (await import("node:fs")).constants.COPYFILE_EXCL,
      );
      return;
    }
    case "rename": {
      const root = rootPath(request.root);
      await assertTestProfileParents(request.root, root, request.source_relative_path);
      await assertTestProfileParents(request.root, root, request.destination_relative_path);
      const source = path.join(root, request.source_relative_path);
      const destination = path.join(root, request.destination_relative_path);
      if (request.replace) {
        await fs.rename(source, destination);
      } else {
        await fs.link(source, destination);
        await fs.unlink(source);
      }
      return;
    }
    case "unlink": {
      const root = rootPath(request.root);
      await assertTestProfileParents(request.root, root, request.relative_path);
      await fs.unlink(path.join(root, request.relative_path)).catch((error) => {
        if (!(request.missing_ok && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      });
      return;
    }
    case "unlink-external-identity": {
      const metadata = await fs.lstat(request.absolute_path, { bigint: true });
      if (
        !metadata.isFile()
        || metadata.dev.toString() !== request.expected_device
        || metadata.ino.toString() !== request.expected_inode
        || metadata.size.toString() !== request.expected_size
        || metadata.mtimeNs.toString() !== request.expected_modified_at_ns
      ) {
        throw new Error("Staged external file identity changed; replacement preserved.");
      }
      await fs.unlink(request.absolute_path);
      return;
    }
  }
}

async function execute(request: ProfileFsRequest): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    await executeTestFallback(request);
    return;
  }
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) {
    throw new ApiError({
      status: 503,
      code: "safe_file_mutation_unavailable",
      message: "The desktop safe-file service is unavailable.",
      retryable: true,
    });
  }
  const body = JSON.stringify({ ...request, request_id: randomUUID() });
  for (let attempt = 0; ; attempt += 1) {
    const response = await bridgeFetch(bridge, "/profile-fs", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (response?.ok) return;
    if (
      response?.status === 409
      && (request.operation === "rename" || request.operation === "write")
      && !request.replace
    ) {
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      if (payload?.error === "Profile destination already exists") {
        const conflict = new Error("Profile destination already exists.") as NodeJS.ErrnoException;
        conflict.code = "EEXIST";
        throw conflict;
      }
    }
    const retryableBeforeExecution = response?.status === 429;
    const retryableIdempotentTransport = response === null;
    if (
      (!retryableBeforeExecution && !retryableIdempotentTransport)
      || attempt >= CAPACITY_RETRY_DELAYS_MS.length
    ) {
      throw new ApiError({
        status: 503,
        code: "safe_file_mutation_failed",
        message: "The desktop safe-file service rejected the operation.",
        retryable: true,
      });
    }
    await response?.body?.cancel().catch(() => undefined);
    await waitForCapacity(CAPACITY_RETRY_DELAYS_MS[attempt]!);
  }
}

export function profileRelativePath(root: NativeProfileRoot, absolutePath: string): string {
  const rootAbsolute = path.resolve(rootPath(root));
  const relative = path.relative(rootAbsolute, path.resolve(absolutePath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Path is outside the selected profile root.");
  }
  return validateRelativePath(relative.split(path.sep).join("/"));
}

export async function nativeProfileMkdir(
  root: NativeProfileRoot,
  relativePath: string,
): Promise<void> {
  await execute({ operation: "mkdir", root, relative_path: validateRelativePath(relativePath) });
}

export async function nativeProfileWrite(
  root: NativeProfileRoot,
  relativePath: string,
  bytes: Buffer,
  options: { replace: boolean },
): Promise<void> {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lunery-native-write-"));
  const sourcePath = path.join(tempDirectory, randomUUID());
  try {
    const source = await fs.open(sourcePath, "wx", 0o600);
    try {
      await source.writeFile(bytes);
      await source.sync();
    } finally {
      await source.close();
    }
    await execute({
      operation: "write",
      root,
      relative_path: validateRelativePath(relativePath),
      source_path: sourcePath,
      replace: options.replace,
    });
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function nativeProfileRename(
  root: NativeProfileRoot,
  sourceRelativePath: string,
  destinationRelativePath: string,
  options: { replace: boolean } = { replace: false },
): Promise<void> {
  await execute({
    operation: "rename",
    root,
    source_relative_path: validateRelativePath(sourceRelativePath),
    destination_relative_path: validateRelativePath(destinationRelativePath),
    replace: options.replace,
  });
}

export async function nativeProfileUnlink(
  root: NativeProfileRoot,
  relativePath: string,
  options: { missingOk: boolean },
): Promise<void> {
  await execute({
    operation: "unlink",
    root,
    relative_path: validateRelativePath(relativePath),
    missing_ok: options.missingOk,
  });
}

export async function nativeUnlinkExternalIdentity(
  absolutePath: string,
  expected: { device: string; inode: string; sizeBytes: string; modifiedAtNs: string },
): Promise<void> {
  if (!path.isAbsolute(absolutePath)) throw new Error("External unlink path must be absolute.");
  await execute({
    operation: "unlink-external-identity",
    absolute_path: absolutePath,
    expected_device: expected.device,
    expected_inode: expected.inode,
    expected_size: expected.sizeBytes,
    expected_modified_at_ns: expected.modifiedAtNs,
  });
}
