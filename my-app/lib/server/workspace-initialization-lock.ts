import "server-only";

import { randomUUID } from "node:crypto";
import {
  nativeProfileUnlink,
  nativeProfileWrite,
} from "@/lib/server/native-profile-fs";

const WORKSPACE_INITIALIZATION_LOCK = ".workspace-initialization.lock";
const LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 500] as const;
const LOCK_WAIT_TIMEOUT_MS = 60_000;

export const __workspaceInitializationLockTestHooks = {
  now: null as null | (() => number),
  sleep: null as null | ((delayMs: number) => Promise<void> | void),
};

function now(): number {
  return __workspaceInitializationLockTestHooks.now?.() ?? Date.now();
}

async function sleep(delayMs: number): Promise<void> {
  if (__workspaceInitializationLockTestHooks.sleep) {
    await __workspaceInitializationLockTestHooks.sleep(delayMs);
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function isDestinationCollision(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

async function acquireWorkspaceInitializationLock(): Promise<void> {
  const startedAt = now();
  let attempt = 0;
  for (;;) {
    try {
      await nativeProfileWrite(
        "runtime",
        WORKSPACE_INITIALIZATION_LOCK,
        Buffer.from(randomUUID(), "utf8"),
        { replace: false },
      );
      return;
    } catch (error) {
      if (!isDestinationCollision(error)) throw error;
      if (now() - startedAt >= LOCK_WAIT_TIMEOUT_MS) {
        throw new Error("Timed out waiting for workspace initialization.", {
          cause: error,
        });
      }
      const delay = LOCK_RETRY_DELAYS_MS[
        Math.min(attempt, LOCK_RETRY_DELAYS_MS.length - 1)
      ]!;
      attempt += 1;
      await sleep(delay);
    }
  }
}

/**
 * Serialize first-boot recovery across separately compiled Next server bundles.
 *
 * The native profile service creates the lock without replacement, so the
 * arbiter is shared even when JavaScript globals are not. Tauri removes a
 * crash-stale lock before every real desktop-server spawn.
 */
export async function withWorkspaceInitializationLock<T>(
  work: () => Promise<T>,
): Promise<T> {
  await acquireWorkspaceInitializationLock();
  let workError: unknown;
  try {
    return await work();
  } catch (error) {
    workError = error;
    throw error;
  } finally {
    try {
      await nativeProfileUnlink("runtime", WORKSPACE_INITIALIZATION_LOCK, {
        missingOk: false,
      });
    } catch (releaseError) {
      if (workError !== undefined) {
        console.error("[workspace_initialization_lock_release_failed]", {
          error: releaseError,
        });
      } else {
        throw releaseError;
      }
    }
  }
}
