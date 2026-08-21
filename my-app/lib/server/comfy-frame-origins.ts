// ComfyUI frame origins for the per-request CSP.
//
// The /comfy workspace embeds the user's own ComfyUI frontend in an iframe, so
// those responses need `frame-src` entries for the configured endpoints. This
// reader is deliberately standalone (plain fs read, no bridge imports) so the
// proxy can call it on every HTML request, and short-caches to keep request
// overhead at one stat() per second at most.

import * as fs from "node:fs";
import * as path from "node:path";
import { luneryConfigDir } from "@/lib/server/lunery-profile";

const CACHE_TTL_MS = 1000;

let cache: { origins: string[]; checkedAt: number; mtimeMs: number | null } | null = null;

/**
 * Origins (scheme://host:port) of every saved ComfyUI connection. Malformed
 * entries are skipped — an origin that cannot be parsed is never granted
 * frame-src.
 */
export function listComfyFrameOrigins(): string[] {
  const storePath = path.join(luneryConfigDir(), "comfyui-connections.json");
  const now = Date.now();
  let mtimeMs: number | null = null;
  try {
    mtimeMs = fs.statSync(storePath).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  if (cache && now - cache.checkedAt < CACHE_TTL_MS && cache.mtimeMs === mtimeMs) {
    return cache.origins;
  }

  const origins = new Set<string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      connections?: Array<{ endpoint?: unknown }>;
    };
    if (Array.isArray(parsed.connections)) {
      for (const connection of parsed.connections) {
        const endpoint =
          connection && typeof connection.endpoint === "string"
            ? connection.endpoint.trim()
            : "";
        if (!/^https?:\/\//.test(endpoint)) continue;
        try {
          origins.add(new URL(endpoint).origin);
        } catch {
          // Skip unparseable endpoints.
        }
      }
    }
  } catch {
    // Missing/corrupt store → no frame origins.
  }

  cache = { origins: [...origins], checkedAt: now, mtimeMs };
  return cache.origins;
}
