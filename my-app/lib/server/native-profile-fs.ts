import "server-only";

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { bridgeFetch, requireDesktopBridge } from "@/lib/server/desktop-bridge";
import {
  luneryConfigDir,
  luneryDataDir,
  luneryLogDir,
  luneryMediaDir,
  luneryModelsDir,
  luneryPgliteDir,
  luneryProfileRoot,
  luneryRuntimeDir,
} from "@/lib/server/lunery-profile";
import { ApiError } from "@/lib/server/errors";

export type NativeProfileRoot = "config" | "media" | "models" | "runtime";
export type NativeWorkspaceRestoreRoot = "config" | "media";
export type NativeWorkspaceRestoreOriginalIdentities = Record<
  NativeWorkspaceRestoreRoot,
  { device: string; inode: string }
>;
export type NativeWorkspaceRestoreStagedIdentities =
  | Record<NativeWorkspaceRestoreRoot, { device: string; inode: string }>
  | null;

const WORKSPACE_RESTORE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

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
    }
  | ({ operation: "prepare-workspace-restore"; token: string } & RestoreIdentityRequest)
  | {
      operation: "write-workspace-restore-file";
      token: string;
      root: NativeWorkspaceRestoreRoot;
      relative_path: string;
      source_path: string;
    }
  | { operation: "seal-workspace-restore-root"; token: string; root: NativeWorkspaceRestoreRoot }
  | ({ operation: "attest-workspace-restore-stages"; token: string } & RestoreStagedIdentityRequest)
  | { operation: "promote-workspace-restore-roots"; token: string }
  | ({ operation: "rollback-workspace-restore-roots"; token: string } & RestoreIdentityRequest & RestoreStagedIdentityRequest)
  | ({ operation: "cleanup-workspace-restore"; token: string } & RestoreIdentityRequest & RestoreStagedIdentityRequest)
  | ({ operation: "refresh-workspace-restore-roots"; token: string } & RestoreStagedIdentityRequest);

type RestoreIdentityRequest = {
  config_original_device: string;
  config_original_inode: string;
  media_original_device: string;
  media_original_inode: string;
};

type RestoreStagedIdentityRequest = {
  config_staged_device: string | null;
  config_staged_inode: string | null;
  media_staged_device: string | null;
  media_staged_inode: string | null;
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

function validateWorkspaceRestoreToken(token: string): string {
  if (!WORKSPACE_RESTORE_TOKEN_PATTERN.test(token)) {
    throw new Error("Invalid workspace restore token.");
  }
  return token;
}

function restoreIdentityRequest(
  identities: NativeWorkspaceRestoreOriginalIdentities,
): RestoreIdentityRequest {
  for (const root of ["media", "config"] as const) {
    if (!/^\d+$/.test(identities[root].device) || !/^\d+$/.test(identities[root].inode)) {
      throw new Error("Invalid workspace restore root identity.");
    }
  }
  return {
    config_original_device: identities.config.device,
    config_original_inode: identities.config.inode,
    media_original_device: identities.media.device,
    media_original_inode: identities.media.inode,
  };
}

function identitiesFromRequest(request: RestoreIdentityRequest): NativeWorkspaceRestoreOriginalIdentities {
  return {
    config: {
      device: request.config_original_device,
      inode: request.config_original_inode,
    },
    media: {
      device: request.media_original_device,
      inode: request.media_original_inode,
    },
  };
}

function stagedIdentityRequest(
  identities: NativeWorkspaceRestoreStagedIdentities,
): RestoreStagedIdentityRequest {
  if (!identities) {
    return {
      config_staged_device: null,
      config_staged_inode: null,
      media_staged_device: null,
      media_staged_inode: null,
    };
  }
  for (const root of ["media", "config"] as const) {
    if (!/^\d+$/.test(identities[root].device) || !/^\d+$/.test(identities[root].inode)) {
      throw new Error("Invalid workspace restore staged identity.");
    }
  }
  return {
    config_staged_device: identities.config.device,
    config_staged_inode: identities.config.inode,
    media_staged_device: identities.media.device,
    media_staged_inode: identities.media.inode,
  };
}

function stagedIdentitiesFromRequest(
  request: RestoreStagedIdentityRequest,
): NativeWorkspaceRestoreStagedIdentities {
  const values = [
    request.config_staged_device,
    request.config_staged_inode,
    request.media_staged_device,
    request.media_staged_inode,
  ];
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) {
    throw new Error("Incomplete workspace restore staged identity.");
  }
  return {
    config: {
      device: request.config_staged_device!,
      inode: request.config_staged_inode!,
    },
    media: {
      device: request.media_staged_device!,
      inode: request.media_staged_inode!,
    },
  };
}

function fallbackRestorePaths(root: NativeWorkspaceRestoreRoot, token: string) {
  const live = path.resolve(/* turbopackIgnore: true */ rootPath(root));
  const prefix = path.join(path.dirname(live), `.${path.basename(live)}.restore`);
  return {
    live,
    staged: `${prefix}-stage-${token}`,
    previous: `${prefix}-previous-${token}`,
    discarded: `${prefix}-discarded-${token}`,
  };
}

type FallbackDirectoryIdentity = { device: string; inode: string };
const fallbackRestoreAuthorities = new Map<
  string,
  Record<NativeWorkspaceRestoreRoot, FallbackDirectoryIdentity>
>();

export function resetNativeProfileFsRestoreForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Native profile restore state can only be reset in tests.");
  }
  fallbackRestoreAuthorities.clear();
}

async function fallbackRealDirectory(target: string): Promise<import("node:fs").BigIntStats> {
  const metadata = await fs.lstat(target, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Workspace restore path must be a real directory.");
  }
  return metadata;
}

async function fallbackDirectoryExists(target: string): Promise<boolean> {
  try {
    await fallbackRealDirectory(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sameFallbackIdentity(
  metadata: import("node:fs").BigIntStats,
  expected: FallbackDirectoryIdentity,
): boolean {
  return metadata.dev.toString() === expected.device && metadata.ino.toString() === expected.inode;
}

async function fallbackDirectoryIsEmpty(target: string): Promise<boolean> {
  await fallbackRealDirectory(target);
  return (await fs.readdir(target)).length === 0;
}

async function assertFallbackRestoreAuthority(
  token: string,
  root: NativeWorkspaceRestoreRoot,
): Promise<string> {
  const authority = fallbackRestoreAuthorities.get(token)?.[root];
  if (!authority) throw new Error("Workspace restore staging authority is unavailable.");
  const staged = fallbackRestorePaths(root, token).staged;
  const metadata = await fallbackRealDirectory(staged);
  if (
    metadata.dev.toString() !== authority.device
    || metadata.ino.toString() !== authority.inode
  ) {
    throw new Error("Workspace restore staging root identity changed.");
  }
  return staged;
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
      if (metadata.isSymbolicLink()) {
        throw new Error(
          rootKind === "media"
            ? "Storage path component is a symlink."
            : "Profile resource path contains a symlink.",
        );
      }
      if (!metadata.isDirectory()) {
        const conflict = new Error("Profile destination already exists.") as NodeJS.ErrnoException;
        conflict.code = "EEXIST";
        throw conflict;
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
      await fs.mkdir(
        path.join(/* turbopackIgnore: true */ root, request.relative_path),
        { recursive: true },
      );
      return;
    }
    case "write": {
      const root = rootPath(request.root);
      await assertTestProfileParents(request.root, root, request.relative_path);
      const destination = path.join(
        /* turbopackIgnore: true */ root,
        request.relative_path,
      );
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
      const source = path.join(
        /* turbopackIgnore: true */ root,
        request.source_relative_path,
      );
      const destination = path.join(
        /* turbopackIgnore: true */ root,
        request.destination_relative_path,
      );
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
      await fs.unlink(path.join(
        /* turbopackIgnore: true */ root,
        request.relative_path,
      )).catch((error) => {
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
    case "prepare-workspace-restore": {
      const token = validateWorkspaceRestoreToken(request.token);
      if (fallbackRestoreAuthorities.has(token)) return;
      if (fallbackRestoreAuthorities.size > 0) {
        throw new Error("Another workspace restore staging authority is active.");
      }
      const mediaLive = fallbackRestorePaths("media", token).live;
      const configLive = fallbackRestorePaths("config", token).live;
      const relativeMediaToConfig = path.relative(mediaLive, configLive);
      const relativeConfigToMedia = path.relative(configLive, mediaLive);
      if (
        mediaLive === configLive
        || (!relativeMediaToConfig.startsWith("..") && !path.isAbsolute(relativeMediaToConfig))
        || (!relativeConfigToMedia.startsWith("..") && !path.isAbsolute(relativeConfigToMedia))
      ) {
        throw new Error("Config and media restore roots must not overlap.");
      }
      const protectedResources = [
        luneryProfileRoot(),
        luneryDataDir(),
        luneryPgliteDir(),
        luneryModelsDir(),
        luneryRuntimeDir(),
        luneryLogDir(),
      ].map((resource) => path.resolve(resource));
      for (const restoreRoot of [mediaLive, configLive]) {
        if (protectedResources.some((resource) => {
          const relative = path.relative(restoreRoot, resource);
          return !relative.startsWith("..") && !path.isAbsolute(relative);
        })) {
          throw new Error(
            "Workspace restore root must not contain a protected profile resource.",
          );
        }
      }
      const authority = {} as Record<NativeWorkspaceRestoreRoot, FallbackDirectoryIdentity>;
      const created: string[] = [];
      try {
        for (const root of ["media", "config"] as const) {
          const paths = fallbackRestorePaths(root, token);
          await fallbackRealDirectory(path.dirname(paths.live));
          if (!(await fallbackDirectoryExists(paths.live))) {
            await fs.mkdir(paths.live, { recursive: false, mode: 0o700 });
          }
          const liveMetadata = await fallbackRealDirectory(paths.live);
          const expected = identitiesFromRequest(request)[root];
          if (
            liveMetadata.dev.toString() !== expected.device
            || liveMetadata.ino.toString() !== expected.inode
          ) {
            throw new Error("Workspace restore live root identity changed.");
          }
          for (const residue of [paths.staged, paths.previous, paths.discarded]) {
            if (await fallbackDirectoryExists(residue)) {
              throw new Error("Workspace restore target already exists.");
            }
          }
          await fs.mkdir(paths.staged, { recursive: false, mode: 0o700 });
          created.push(paths.staged);
          const metadata = await fallbackRealDirectory(paths.staged);
          authority[root] = {
            device: metadata.dev.toString(),
            inode: metadata.ino.toString(),
          };
        }
        fallbackRestoreAuthorities.set(token, authority);
      } catch (error) {
        for (const staged of created.reverse()) {
          await fs.rmdir(staged).catch(() => undefined);
        }
        throw error;
      }
      return;
    }
    case "write-workspace-restore-file": {
      const token = validateWorkspaceRestoreToken(request.token);
      const relativePath = validateRelativePath(request.relative_path);
      const staged = await assertFallbackRestoreAuthority(token, request.root);
      await assertTestProfileParents(request.root, staged, relativePath);
      const destination = path.join(staged, ...relativePath.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(
        request.source_path,
        destination,
        (await import("node:fs")).constants.COPYFILE_EXCL,
      );
      return;
    }
    case "seal-workspace-restore-root": {
      const staged = await assertFallbackRestoreAuthority(
        validateWorkspaceRestoreToken(request.token),
        request.root,
      );
      const handle = await fs.open(/* turbopackIgnore: true */ staged, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    }
    case "attest-workspace-restore-stages": {
      const token = validateWorkspaceRestoreToken(request.token);
      const staged = stagedIdentitiesFromRequest(request);
      if (!staged) throw new Error("Workspace restore staged identity is required.");
      for (const root of ["media", "config"] as const) {
        await assertFallbackRestoreAuthority(token, root);
        const metadata = await fallbackRealDirectory(fallbackRestorePaths(root, token).staged);
        if (!sameFallbackIdentity(metadata, staged[root])) {
          throw new Error("Workspace restore staging root identity changed.");
        }
      }
      return;
    }
    case "promote-workspace-restore-roots": {
      const token = validateWorkspaceRestoreToken(request.token);
      for (const root of ["media", "config"] as const) {
        const paths = fallbackRestorePaths(root, token);
        await fallbackRealDirectory(paths.live);
        await assertFallbackRestoreAuthority(token, root);
        if (
          await fallbackDirectoryExists(paths.previous)
          || await fallbackDirectoryExists(paths.discarded)
        ) {
          throw new Error("Workspace restore promotion destination already exists.");
        }
      }
      for (const root of ["media", "config"] as const) {
        const paths = fallbackRestorePaths(root, token);
        await fs.rename(paths.live, paths.previous);
        await fs.rename(paths.staged, paths.live);
      }
      return;
    }
    case "rollback-workspace-restore-roots": {
      const token = validateWorkspaceRestoreToken(request.token);
      const expectedIdentities = identitiesFromRequest(request);
      const stagedIdentities = stagedIdentitiesFromRequest(request);
      for (const root of ["config", "media"] as const) {
        const paths = fallbackRestorePaths(root, token);
        const previousExists = await fallbackDirectoryExists(paths.previous);
        const liveExists = await fallbackDirectoryExists(paths.live);
        const stagedExists = await fallbackDirectoryExists(paths.staged);
        const discardedExists = await fallbackDirectoryExists(paths.discarded);
        if (!stagedIdentities) {
          if (previousExists || discardedExists || !liveExists) {
            throw new Error("Durable workspace restore staged identity is unavailable.");
          }
          const liveMetadata = await fallbackRealDirectory(paths.live);
          if (!sameFallbackIdentity(liveMetadata, expectedIdentities[root])) {
            throw new Error("Workspace restore live root identity changed during rollback.");
          }
          if (stagedExists && !(await fallbackDirectoryIsEmpty(paths.staged))) {
            throw new Error("Unattested workspace restore staging root is not empty.");
          }
          continue;
        }
        if (stagedExists) {
          const stagedMetadata = await fallbackRealDirectory(paths.staged);
          if (!sameFallbackIdentity(stagedMetadata, stagedIdentities[root])) {
            throw new Error("Workspace restore staging root identity changed during rollback.");
          }
        }
        if (previousExists) {
          const previousMetadata = await fallbackRealDirectory(paths.previous);
          if (!sameFallbackIdentity(previousMetadata, expectedIdentities[root])) {
            throw new Error("Workspace restore previous root identity changed during rollback.");
          }
          if (discardedExists && !(await fallbackDirectoryIsEmpty(paths.discarded))) {
            throw new Error("Workspace restore discarded placeholder is not empty.");
          }
          if (liveExists) {
            const liveMetadata = await fallbackRealDirectory(paths.live);
            const promoted = sameFallbackIdentity(liveMetadata, stagedIdentities[root]);
            const placeholder = stagedExists && await fallbackDirectoryIsEmpty(paths.live);
            if (!promoted && !placeholder) {
              throw new Error("Workspace restore live root identity changed during rollback.");
            }
          }
        } else if (!liveExists) {
          throw new Error("Workspace restore root is missing during rollback.");
        } else {
          const liveMetadata = await fallbackRealDirectory(paths.live);
          if (!sameFallbackIdentity(liveMetadata, expectedIdentities[root])) {
            throw new Error("Workspace restore live root identity changed during rollback.");
          }
        }
      }
      for (const root of ["config", "media"] as const) {
        const paths = fallbackRestorePaths(root, token);
        const previousExists = await fallbackDirectoryExists(paths.previous);
        const liveExists = await fallbackDirectoryExists(paths.live);
        const stagedExists = await fallbackDirectoryExists(paths.staged);
        if (previousExists) {
          const previousMetadata = await fallbackRealDirectory(paths.previous);
          if (!sameFallbackIdentity(previousMetadata, expectedIdentities[root])) {
            throw new Error("Workspace restore previous root identity changed during rollback.");
          }
          if (liveExists) {
            const liveMetadata = await fallbackRealDirectory(paths.live);
            if (sameFallbackIdentity(liveMetadata, stagedIdentities![root])) {
              if (stagedExists) {
                throw new Error("Workspace restore rollback staging destination already exists.");
              }
              await fs.rename(paths.live, paths.staged);
            } else if (await fallbackDirectoryExists(paths.discarded)) {
              if (!(await fallbackDirectoryIsEmpty(paths.live))) {
                throw new Error("Workspace restore live root identity changed during rollback.");
              }
              await fs.rmdir(paths.live);
            } else {
              await fs.rename(paths.live, paths.discarded);
            }
          }
          await fs.rename(paths.previous, paths.live);
        }
        for (const residue of [paths.staged, paths.discarded]) {
          await fs.rm(residue, { recursive: true, force: true });
        }
      }
      fallbackRestoreAuthorities.delete(token);
      return;
    }
    case "cleanup-workspace-restore": {
      const token = validateWorkspaceRestoreToken(request.token);
      const expectedIdentities = identitiesFromRequest(request);
      const stagedIdentities = stagedIdentitiesFromRequest(request);
      if (!stagedIdentities) {
        throw new Error("Durable workspace restore staged identity is unavailable.");
      }
      for (const root of ["media", "config"] as const) {
        const paths = fallbackRestorePaths(root, token);
        const liveMetadata = await fallbackRealDirectory(paths.live);
        if (!sameFallbackIdentity(liveMetadata, stagedIdentities[root])) {
          throw new Error("Workspace restore promoted root identity changed during cleanup.");
        }
        if (await fallbackDirectoryExists(paths.staged)) {
          const stagedMetadata = await fallbackRealDirectory(paths.staged);
          if (!sameFallbackIdentity(stagedMetadata, stagedIdentities[root])) {
            throw new Error("Workspace restore staging root identity changed during cleanup.");
          }
        }
        if (
          await fallbackDirectoryExists(paths.discarded)
          && !(await fallbackDirectoryIsEmpty(paths.discarded))
        ) {
          throw new Error("Workspace restore discarded placeholder is not empty.");
        }
        if (await fallbackDirectoryExists(paths.previous)) {
          const previousMetadata = await fallbackRealDirectory(paths.previous);
          if (
            previousMetadata.dev.toString() !== expectedIdentities[root].device
            || previousMetadata.ino.toString() !== expectedIdentities[root].inode
          ) {
            throw new Error("Workspace restore previous root identity changed during cleanup.");
          }
        }
      }
      for (const root of ["media", "config"] as const) {
        const paths = fallbackRestorePaths(root, token);
        if (await fallbackDirectoryExists(paths.previous)) {
          const previousMetadata = await fallbackRealDirectory(paths.previous);
          if (
            previousMetadata.dev.toString() !== expectedIdentities[root].device
            || previousMetadata.ino.toString() !== expectedIdentities[root].inode
          ) {
            throw new Error("Workspace restore previous root identity changed during cleanup.");
          }
        }
        for (const residue of [paths.staged, paths.previous, paths.discarded]) {
          await fs.rm(residue, { recursive: true, force: true });
        }
      }
      fallbackRestoreAuthorities.delete(token);
      return;
    }
    case "refresh-workspace-restore-roots": {
      validateWorkspaceRestoreToken(request.token);
      const stagedIdentities = stagedIdentitiesFromRequest(request);
      if (!stagedIdentities) {
        throw new Error("Durable workspace restore staged identity is unavailable.");
      }
      for (const root of ["media", "config"] as const) {
        const metadata = await fallbackRealDirectory(rootPath(root));
        if (!sameFallbackIdentity(metadata, stagedIdentities[root])) {
          throw new Error("Workspace restore promoted root identity changed during refresh.");
        }
      }
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
  const rootAbsolute = path.resolve(/* turbopackIgnore: true */ rootPath(root));
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

export async function nativePrepareWorkspaceRestore(
  token: string,
  identities: NativeWorkspaceRestoreOriginalIdentities,
): Promise<void> {
  await execute({
    operation: "prepare-workspace-restore",
    token: validateWorkspaceRestoreToken(token),
    ...restoreIdentityRequest(identities),
  });
}

export async function nativeWriteWorkspaceRestoreFile(
  token: string,
  root: NativeWorkspaceRestoreRoot,
  relativePath: string,
  bytes: Buffer,
): Promise<void> {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lunery-native-restore-"));
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
      operation: "write-workspace-restore-file",
      token: validateWorkspaceRestoreToken(token),
      root,
      relative_path: validateRelativePath(relativePath),
      source_path: sourcePath,
    });
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function nativeSealWorkspaceRestoreRoot(
  token: string,
  root: NativeWorkspaceRestoreRoot,
): Promise<void> {
  await execute({
    operation: "seal-workspace-restore-root",
    token: validateWorkspaceRestoreToken(token),
    root,
  });
}

export async function nativeAttestWorkspaceRestoreStages(
  token: string,
  identities: Exclude<NativeWorkspaceRestoreStagedIdentities, null>,
): Promise<void> {
  await execute({
    operation: "attest-workspace-restore-stages",
    token: validateWorkspaceRestoreToken(token),
    ...stagedIdentityRequest(identities),
  });
}

export async function nativePromoteWorkspaceRestoreRoots(token: string): Promise<void> {
  await execute({
    operation: "promote-workspace-restore-roots",
    token: validateWorkspaceRestoreToken(token),
  });
}

export async function nativeRollbackWorkspaceRestoreRoots(
  token: string,
  identities: NativeWorkspaceRestoreOriginalIdentities,
  staged: NativeWorkspaceRestoreStagedIdentities,
): Promise<void> {
  await execute({
    operation: "rollback-workspace-restore-roots",
    token: validateWorkspaceRestoreToken(token),
    ...restoreIdentityRequest(identities),
    ...stagedIdentityRequest(staged),
  });
}

export async function nativeCleanupWorkspaceRestore(
  token: string,
  identities: NativeWorkspaceRestoreOriginalIdentities,
  staged: NativeWorkspaceRestoreStagedIdentities,
): Promise<void> {
  await execute({
    operation: "cleanup-workspace-restore",
    token: validateWorkspaceRestoreToken(token),
    ...restoreIdentityRequest(identities),
    ...stagedIdentityRequest(staged),
  });
}

export async function nativeRefreshWorkspaceRestoreRoots(
  token: string,
  staged: NativeWorkspaceRestoreStagedIdentities,
): Promise<void> {
  await execute({
    operation: "refresh-workspace-restore-roots",
    token: validateWorkspaceRestoreToken(token),
    ...stagedIdentityRequest(staged),
  });
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
