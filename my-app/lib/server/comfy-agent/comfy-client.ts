// Pinned-fetch client for the attached ComfyUI server.
//
// Every request goes to the already-validated active endpoint through the
// DNS-pinned transport. Server-mutating Manager operations (install/reboot)
// are intentionally not exposed here: their current contract needs versioned
// package metadata plus a separate queue-start step, and they require a
// deterministic authorization the agent cannot provide, so they are out of
// scope until both are in place.

import "server-only";
import {
  createPinnedProviderFetch,
  type ValidatedProviderEndpoint as ValidatedComfyEndpoint,
} from "@/lib/server/byok-shared";
import type { ComfySystemStats } from "@/lib/server/comfy-endpoint";

export interface ComfyRawResponse {
  ok: boolean;
  status: number;
  json: unknown | null;
}

export async function comfyRequest(
  endpoint: ValidatedComfyEndpoint,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ComfyRawResponse> {
  const transport = createPinnedProviderFetch(endpoint);
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 15_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await transport(new URL(path, endpoint.url), {
      method: init.method ?? "GET",
      cache: "no-store",
      signal,
      ...(init.body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(init.body),
          }),
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
    throw new Error(`ComfyUI is not reachable.${detail}`);
  }
  const json = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, json };
}

/** Queue an API-format workflow. Returns the server-assigned prompt id. */
export async function queueComfyPrompt(
  endpoint: ValidatedComfyEndpoint,
  prompt: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<string> {
  const response = await comfyRequest(endpoint, "prompt", {
    method: "POST",
    body: { prompt, client_id: "lunery-agent" },
    timeoutMs: 20_000,
    signal: abortSignal,
  });
  if (!response.ok) {
    const errorText =
      response.json && typeof response.json === "object" && "error" in (response.json as Record<string, unknown>)
        ? String((response.json as Record<string, unknown>).error)
        : `HTTP ${response.status}`;
    throw new Error(`ComfyUI rejected the prompt: ${errorText}`);
  }
  const promptId =
    response.json && typeof response.json === "object"
      ? (response.json as Record<string, unknown>).prompt_id
      : undefined;
  if (typeof promptId !== "string" || !promptId) {
    throw new Error("ComfyUI did not return a prompt id.");
  }
  return promptId;
}

/**
 * Cancel a queued/running prompt on the server: delete it from the queue if it
 * has not started and interrupt it if it is executing. Best-effort — a failure
 * here must not mask the reason cancellation was requested (a user Stop).
 */
export async function cancelComfyPrompt(
  endpoint: ValidatedComfyEndpoint,
  promptId: string,
): Promise<void> {
  await Promise.allSettled([
    comfyRequest(endpoint, "queue", {
      method: "POST",
      body: { delete: [promptId] },
      timeoutMs: 4_000,
    }),
    comfyRequest(endpoint, "interrupt", { method: "POST", timeoutMs: 4_000 }),
  ]);
}

export type ComfyTerminalStatus = "completed" | "failed";

interface ComfyHistoryStatus {
  status?: { completed?: boolean; status_str?: string };
}

/**
 * Poll `/history/{promptId}` until the job reaches a terminal state. Resolves
 * with "completed"/"failed", or null when `timeoutMs` elapses without a verdict
 * (the caller then leaves the last-known state rather than lying). Throws an
 * AbortError as soon as `abortSignal` fires so the caller can cancel the job.
 */
export async function pollComfyJobUntilTerminal(
  endpoint: ValidatedComfyEndpoint,
  promptId: string,
  abortSignal: AbortSignal,
  { timeoutMs = 30 * 60_000, intervalMs = 1_500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<ComfyTerminalStatus | null> {
  const throwIfAborted = () => {
    if (abortSignal.aborted) throw new DOMException("Aborted", "AbortError");
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    throwIfAborted();
    let response: ComfyRawResponse;
    try {
      response = await comfyRequest(endpoint, `history/${promptId}`, {
        timeoutMs: 5_000,
        signal: abortSignal,
      });
    } catch {
      throwIfAborted();
      continue; // transient — the next tick retries
    }
    if (!response.ok || !response.json || typeof response.json !== "object") continue;
    const entry = (response.json as Record<string, ComfyHistoryStatus>)[promptId];
    if (entry?.status?.completed) return "completed";
    if (entry?.status?.status_str === "error") return "failed";
  }
  return null;
}

export type { ComfySystemStats };
