// ComfyUI availability for the runtime supply layer.
//
// The generic bridge `/runtime-probe` only speaks loopback, so a configured
// ComfyUI connection (LAN / Tailscale / remote box) needs its own probe: the
// endpoint is re-validated here, then GET /system_stats goes out through the
// pinned fetch like every other outbound provider call.

import "server-only";
import { fetchComfySystemStats, validateComfyEndpoint } from "@/lib/server/comfy-endpoint";
import { getActiveComfyConnection, type ComfyConnection } from "@/lib/server/comfy-connection-store";

const PROBE_TTL_MS = 30_000;

const probeCache = new Map<string, { reachable: boolean; expiresAt: number }>();
const pendingProbes = new Map<string, Promise<boolean>>();

export async function probeComfyReachable(endpoint: string): Promise<boolean> {
  const now = Date.now();
  const cached = probeCache.get(endpoint);
  if (cached && cached.expiresAt > now) return cached.reachable;

  const inFlight = pendingProbes.get(endpoint);
  if (inFlight) return inFlight;

  const probe = (async () => {
    try {
      const endpointCheck = await validateComfyEndpoint(endpoint);
      if ("error" in endpointCheck) {
        probeCache.set(endpoint, { reachable: false, expiresAt: Date.now() + PROBE_TTL_MS });
        return false;
      }
      await fetchComfySystemStats(endpointCheck, { timeoutMs: 2500 });
      probeCache.set(endpoint, { reachable: true, expiresAt: Date.now() + PROBE_TTL_MS });
      return true;
    } catch {
      probeCache.set(endpoint, { reachable: false, expiresAt: Date.now() + PROBE_TTL_MS });
      return false;
    } finally {
      pendingProbes.delete(endpoint);
    }
  })();

  pendingProbes.set(endpoint, probe);
  return probe;
}

/**
 * The user's explicitly attached ComfyUI, if one is configured. When set it
 * replaces zero-config loopback autodetection: if the chosen server is down,
 * comfy is down — we never silently fall back to a different machine's
 * loopback instance.
 */
export function getAttachedComfyConnection(): ComfyConnection | undefined {
  return getActiveComfyConnection();
}
