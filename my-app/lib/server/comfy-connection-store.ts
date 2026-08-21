// ComfyUI attach connections (endpoint + optional SSH start + last sync).
//
// Like the BYOK store this holds NO secrets — ComfyUI has no credentials. The
// file lives in the profile config dir and is written atomically through the
// native bridge fs so partial writes can never corrupt the connection list.

import "server-only";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { luneryConfigDir } from "@/lib/server/lunery-profile";
import {
  nativeProfileRename,
  nativeProfileUnlink,
  nativeProfileWrite,
} from "@/lib/server/native-profile-fs";
import { withSharedMutationLease } from "@/lib/server/workspace-operation-gate";
import type {
  ComfyConnection,
  ComfyConnectionState,
  ComfySshStart,
  ComfySyncSnapshot,
} from "@/lib/comfy-attach";

export type {
  ComfyConnection,
  ComfyConnectionState,
  ComfySshStart,
  ComfySyncSnapshot,
};

const SSH_HOST_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SSH_COMMAND_MAX_LENGTH = 200;

const storePath = path.join(luneryConfigDir(), "comfyui-connections.json");

const STORE_LOCK = "__luneryComfyConnectionStoreLockV1" as const;
const storeGlobal = globalThis as typeof globalThis & {
  [STORE_LOCK]?: Promise<void>;
};

async function withStoreLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = storeGlobal[STORE_LOCK] ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  storeGlobal[STORE_LOCK] = previous.then(() => current, () => current);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
  }
}

function normalizeSshStart(value: unknown): ComfySshStart | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const hostAlias = typeof record.hostAlias === "string" ? record.hostAlias.trim() : "";
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!hostAlias || !command) return undefined;
  if (!SSH_HOST_ALIAS_PATTERN.test(hostAlias)) return undefined;
  if (command.length > SSH_COMMAND_MAX_LENGTH || /[\r\n\0]/.test(command)) return undefined;
  return { hostAlias, command };
}

function normalizeConnection(value: unknown): ComfyConnection | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const endpoint = typeof record.endpoint === "string" ? record.endpoint.trim() : "";
  if (!id || !name || !/^https?:\/\//.test(endpoint)) return null;

  const now = new Date().toISOString();
  const sshStart = normalizeSshStart(record.sshStart);

  const lastSync =
    record.lastSync && typeof record.lastSync === "object" && typeof (record.lastSync as { at?: unknown }).at === "string"
      ? (record.lastSync as ComfySyncSnapshot)
      : undefined;

  return {
    id,
    name,
    endpoint,
    ...(sshStart ? { sshStart } : {}),
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : now,
    ...(lastSync ? { lastSync } : {}),
  };
}

function loadStore(): ComfyConnectionState {
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { connections: [] };
    }
    const record = parsed as { connections?: unknown; activeConnectionId?: unknown };
    const connections = Array.isArray(record.connections)
      ? record.connections
          .map(normalizeConnection)
          .filter((connection): connection is ComfyConnection => connection !== null)
      : [];
    const activeConnectionId =
      typeof record.activeConnectionId === "string" &&
      connections.some((connection) => connection.id === record.activeConnectionId)
        ? record.activeConnectionId
        : undefined;
    return { connections, ...(activeConnectionId ? { activeConnectionId } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[comfy-connection-store] failed to load:", error);
    }
    return { connections: [] };
  }
}

// Atomic native tmp-write + rename; throws so API routes surface persist
// failures instead of reporting success for state that never reached disk.
async function writeStore(state: ComfyConnectionState): Promise<void> {
  const tmpName = `comfyui-connections.${process.pid}.${randomUUID()}.tmp`;
  try {
    await nativeProfileWrite(
      "config",
      tmpName,
      Buffer.from(JSON.stringify(state, null, 2), "utf8"),
      { replace: false },
    );
    await nativeProfileRename("config", tmpName, path.basename(storePath), {
      replace: true,
    });
  } finally {
    await nativeProfileUnlink("config", tmpName, { missingOk: true }).catch(() => undefined);
  }
}

function requireConnection(state: ComfyConnectionState, id: string): ComfyConnection {
  const connection = state.connections.find((entry) => entry.id === id);
  if (!connection) throw new Error("ComfyUI connection not found.");
  return connection;
}

export function listComfyConnections(): ComfyConnection[] {
  return loadStore().connections;
}

export function getComfyConnection(id: string): ComfyConnection | undefined {
  return loadStore().connections.find((connection) => connection.id === id);
}

/** The connection the workspace embeds / image generation prefers, if any. */
export function getActiveComfyConnection(): ComfyConnection | undefined {
  const state = loadStore();
  return state.connections.find((connection) => connection.id === state.activeConnectionId);
}

export function getComfyConnectionState(): ComfyConnectionState {
  return loadStore();
}

export async function saveComfyConnection(input: {
  id?: string;
  name: string;
  endpoint: string;
  sshStart?: ComfySshStart;
}): Promise<ComfyConnection> {
  return withSharedMutationLease(() =>
    withStoreLock(async () => {
      const state = loadStore();
      const now = new Date().toISOString();
      const sshStart = input.sshStart;

      if (input.id) {
        const existing = requireConnection(state, input.id);
        const updated: ComfyConnection = {
          ...existing,
          name: input.name,
          endpoint: input.endpoint,
          ...(sshStart ? { sshStart } : {}),
          updatedAt: now,
        };
        // Endpoint changed → the old sync snapshot describes another server.
        if (existing.endpoint !== input.endpoint) delete updated.lastSync;
        const next = {
          ...state,
          connections: state.connections.map((connection) =>
            connection.id === input.id ? updated : connection,
          ),
        };
        await writeStore(next);
        return updated;
      }

      const created: ComfyConnection = {
        id: randomUUID(),
        name: input.name,
        endpoint: input.endpoint,
        ...(sshStart ? { sshStart } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const next = {
        connections: [...state.connections, created],
        // First connection becomes active without an explicit activation step.
        activeConnectionId: state.activeConnectionId ?? created.id,
      };
      await writeStore(next);
      return created;
    }),
  );
}

export async function deleteComfyConnection(id: string): Promise<void> {
  await withSharedMutationLease(() =>
    withStoreLock(async () => {
      const state = loadStore();
      if (!state.connections.some((connection) => connection.id === id)) return;
      const next: ComfyConnectionState = {
        connections: state.connections.filter((connection) => connection.id !== id),
      };
      if (state.activeConnectionId === id) {
        // Promote the most recently updated remaining connection, if any.
        const successor = [...next.connections].sort(
          (a, b) => b.updatedAt.localeCompare(a.updatedAt),
        )[0];
        if (successor) next.activeConnectionId = successor.id;
      } else if (state.activeConnectionId) {
        next.activeConnectionId = state.activeConnectionId;
      }
      await writeStore(next);
    }),
  );
}

export async function setActiveComfyConnection(id: string): Promise<void> {
  await withSharedMutationLease(() =>
    withStoreLock(async () => {
      const state = loadStore();
      requireConnection(state, id);
      if (state.activeConnectionId === id) return;
      await writeStore({ ...state, activeConnectionId: id });
    }),
  );
}

export async function setComfySyncSnapshot(
  id: string,
  snapshot: ComfySyncSnapshot,
): Promise<ComfyConnection> {
  return withSharedMutationLease(() =>
    withStoreLock(async () => {
      const state = loadStore();
      const existing = requireConnection(state, id);
      const updated: ComfyConnection = { ...existing, lastSync: snapshot, updatedAt: existing.updatedAt };
      await writeStore({
        ...state,
        connections: state.connections.map((connection) =>
          connection.id === id ? updated : connection,
        ),
      });
      return updated;
    }),
  );
}
