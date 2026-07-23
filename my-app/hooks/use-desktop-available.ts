"use client";

import { useEffect, useState } from "react";
import type { AccelInfo, HardwareInfo, RuntimeProbeResult } from "@/lib/desktop-runtime";

// ---------------------------------------------------------------------------
// Module-level in-flight / short-TTL cache
//
// Every desktop panel needs /api/desktop-runtime/status. We fetch it ONCE,
// cache the PARSED body for TTL_MS, and let all consumers (availability +
// local-runtime list + accel info) read from the one shared result instead of
// each firing its own request.
//
// `invalidateDesktopStatusCache()` lets event-driven consumers (Tauri event +
// visibilitychange) bust the cache so the next read forces a fresh probe.
// ---------------------------------------------------------------------------

const TTL_MS = 10_000; // 10 s — short enough to feel live, long enough to dedupe burst reads

interface LocalRuntime {
  id: string;
  status: string;
  installed?: boolean;
  endpoint?: string;
  label?: string;
}

interface LlamaStatus {
  running: boolean;
  endpoint?: string | null;
  modelPath: string | null;
}

export interface DesktopStatus {
  /** Bridge responded ok (panel is available). */
  ok: boolean;
  /** Parsed `local_runtimes` (null when unreachable / unparsable). */
  localRuntimes: LocalRuntime[] | null;
  /** Hardware acceleration tier from Rust GPU probe (null on web / pre-bridge). */
  accel: AccelInfo | null;
}

let cached: { value: DesktopStatus; expiresAt: number } | null = null;
let inflight: Promise<DesktopStatus> | null = null;
let hardwareCached: { value: HardwareInfo | null; expiresAt: number } | null = null;
let hardwareInflight: Promise<HardwareInfo | null> | null = null;
let cacheGeneration = 0;
const invalidationListeners = new Set<() => void>();

export function subscribeDesktopStatusInvalidation(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

function notifyDesktopStatusInvalidated(): void {
  for (const listener of [...invalidationListeners]) {
    listener();
  }
}

/**
 * Bust the shared status cache. Called by:
 *  - Tauri `local-runtime-changed` event subscriber
 *  - `document.visibilitychange` → visible
 *  - 30s polling fallback in `useLocalModelSummary`
 *
 * Module-level (not a hook) so callers outside React state can invoke it.
 */
export function invalidateDesktopStatusCache(): void {
  cacheGeneration += 1;
  cached = null;
  inflight = null;
  hardwareCached = null;
  hardwareInflight = null;
  notifyDesktopStatusInvalidated();
}

export async function fetchDesktopStatus(): Promise<DesktopStatus> {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }
  if (!inflight) {
    const requestGeneration = cacheGeneration;
    const request = (async () => {
      let value: DesktopStatus;
      try {
        const res = await fetch("/api/desktop-runtime/status", { cache: "no-store" });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { available?: boolean; local_runtimes?: LocalRuntime[]; accel?: AccelInfo }
            | null;
          if (body?.available === false) {
            value = { ok: false, localRuntimes: null, accel: null };
          } else {
            value = {
              ok: true,
              localRuntimes: body?.local_runtimes ?? null,
              accel: body?.accel ?? null,
            };
          }
        } else {
          value = { ok: false, localRuntimes: null, accel: null };
        }
      } catch {
        value = { ok: false, localRuntimes: null, accel: null };
      }
      if (requestGeneration === cacheGeneration) {
        cached = { value, expiresAt: Date.now() + TTL_MS };
      }
      return value;
    })();
    inflight = request;
    void request.finally(() => {
      if (inflight === request) inflight = null;
    });
  }
  return inflight;
}

async function fetchJsonOrNull<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(input, init);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchDesktopHardware(): Promise<HardwareInfo | null> {
  if (hardwareCached && Date.now() < hardwareCached.expiresAt) {
    return hardwareCached.value;
  }
  if (!hardwareInflight) {
    const requestGeneration = cacheGeneration;
    const request = (async () => {
      const value = await fetchJsonOrNull<HardwareInfo>("/api/desktop-runtime/hardware", {
        cache: "no-store",
      });
      if (requestGeneration === cacheGeneration) {
        hardwareCached = { value, expiresAt: Date.now() + TTL_MS };
      }
      return value;
    })();
    hardwareInflight = request;
    void request.finally(() => {
      if (hardwareInflight === request) hardwareInflight = null;
    });
  }
  return hardwareInflight;
}

export function getDesktopRuntime(
  runtimes: LocalRuntime[] | null,
  id: string,
): LocalRuntime | null {
  return runtimes?.find((runtime) => runtime.id === id) ?? null;
}

export async function fetchLlamaStatus(): Promise<LlamaStatus | null> {
  return fetchJsonOrNull<LlamaStatus>("/api/desktop-runtime/llama", { cache: "no-store" });
}

export async function fetchRuntimeProbe(
  endpoint: string,
  timeoutMs = 5000,
): Promise<RuntimeProbeResult | null> {
  if (!isProbeableLoopbackEndpoint(endpoint)) return null;
  return fetchJsonOrNull<RuntimeProbeResult>("/api/desktop-runtime/runtime-probe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function isProbeableLoopbackEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint.trim());
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hooks
//
// useDesktopAvailable():
//   null  — status fetch still in-flight (panel renders its loading state)
//   true  — desktop bridge ok (panel is available)
//   false — bridge non-ok / unreachable (panel self-hides via return null)
//
// useDesktopLocalRuntimes(): the shared `local_runtimes` list (null until
//   resolved / when unreachable). Reuses the same cached fetch — no extra
//   network even when both hooks are mounted together.
//
// useDesktopAccel(): exposes the GPU/accel tier from the same cached probe.
// ---------------------------------------------------------------------------

export function useDesktopStatus(): DesktopStatus | null {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  useEffect(() => {
    let active = true;
    let requestId = 0;
    const load = () => {
      const currentRequestId = ++requestId;
      void fetchDesktopStatus().then((value) => {
        if (active && currentRequestId === requestId) setStatus(value);
      });
    };
    load();
    const unsubscribe = subscribeDesktopStatusInvalidation(load);
    return () => {
      active = false;
      requestId += 1;
      unsubscribe();
    };
  }, []);
  return status;
}

export function useDesktopAvailable(): boolean | null {
  const status = useDesktopStatus();
  return status === null ? null : status.ok;
}

export function useDesktopLocalRuntimes(): LocalRuntime[] | null {
  const status = useDesktopStatus();
  return status?.localRuntimes ?? null;
}

export function useDesktopAccel(): AccelInfo | null {
  const status = useDesktopStatus();
  return status?.accel ?? null;
}

export type { LocalRuntime };
