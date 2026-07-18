// BYOK connection metadata (endpoint + per-role model ids).
//
// NOTE: This deliberately does NOT hold any secrets. The API key is in the OS
// keychain and only read on-demand via the desktop bridge.

import "server-only";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  findByokProvider,
  resolveByokConnectionModels,
  type ByokConnectionModels,
  type ByokModelRole,
} from "@/lib/byok-providers";
import { luneryConfigDir } from "@/lib/server/lunery-profile";

export interface ByokConnectionMeta {
  endpoint: string;
  /** Per-capability model ids. A provider can hold several at once. */
  models?: ByokConnectionModels;
  updatedAt: string;
}

function resolveConnectionStoreDir(): string {
  return luneryConfigDir();
}

const connectionStorePath = path.join(resolveConnectionStoreDir(), "provider-connections.json");

function normalizeConnectionMeta(providerId: string, value: unknown): ByokConnectionMeta | null {
  const provider = findByokProvider(providerId);
  if (!provider) return null;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const endpoint =
    provider.requiresEndpoint && typeof record.endpoint === "string"
      ? record.endpoint.trim()
      : provider.defaultEndpoint;
  if (!endpoint) return null;
  const models = resolveByokConnectionModels(record);
  const updatedAt =
    typeof record.updatedAt === "string" && record.updatedAt.trim()
      ? record.updatedAt
      : new Date(0).toISOString();
  return {
    endpoint,
    ...(models ? { models } : {}),
    updatedAt,
  };
}

function loadConnectionStore(): Map<string, ByokConnectionMeta> {
  const loaded = loadConnectionStorePath(connectionStorePath);
  if (loaded) return loaded;
  return new Map();
}

function loadConnectionStorePath(filePath: string): Map<string, ByokConnectionMeta> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map();
    }
    const entries = Object.entries(parsed as Record<string, unknown>)
      .map(([providerId, meta]) => [providerId, normalizeConnectionMeta(providerId, meta)] as const)
      .filter(
        (entry): entry is readonly [string, ByokConnectionMeta] =>
          Boolean(entry[0].trim()) && entry[1] !== null,
      );
    return new Map(entries);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[byok-connection-store] failed to load metadata:", error);
    }
    return null;
  }
}

// Atomic tmp-write + rename. Throws on failure — callers MUST surface the error
// (and not mutate in-memory state) so the API never reports success for a config
// that never reached disk.
function writeConnectionStore(state: Map<string, ByokConnectionMeta>): void {
  fs.mkdirSync(path.dirname(connectionStorePath), { recursive: true });
  const tmpPath = `${connectionStorePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(state.entries()), null, 2), "utf8");
  fs.renameSync(tmpPath, connectionStorePath);
}

export function getByokConnectionMeta(providerId: string): ByokConnectionMeta | undefined {
  return loadConnectionStore().get(providerId);
}

export function setByokConnectionMeta(providerId: string, meta: ByokConnectionMeta): void {
  const provider = findByokProvider(providerId);
  if (!provider) return;
  // Canonicalize on write: keep only known/non-blank slots. Never persist
  // unknown model fields.
  const models = resolveByokConnectionModels(meta);
  const nextMeta: ByokConnectionMeta = {
    endpoint: provider.requiresEndpoint ? meta.endpoint : provider.defaultEndpoint,
    ...(models ? { models } : {}),
    updatedAt: meta.updatedAt,
  };
  // Always merge against the latest disk state. Next app routes are compiled as
  // independent bundles, so a module-level Map can remain stale forever after a
  // sibling route writes the profile file.
  const next = loadConnectionStore().set(providerId, nextMeta);
  writeConnectionStore(next);
}

/** Read the model id a provider has configured for a specific capability. */
export function getByokConnectionModelId(
  providerId: string,
  role: ByokModelRole,
): string | undefined {
  return loadConnectionStore().get(providerId)?.models?.[role];
}

export function deleteByokConnectionMeta(providerId: string): void {
  const next = loadConnectionStore();
  if (!next.has(providerId)) return;
  next.delete(providerId);
  writeConnectionStore(next);
}

export function listByokConnectionMeta(): Record<string, ByokConnectionMeta> {
  return Object.fromEntries(loadConnectionStore().entries());
}
