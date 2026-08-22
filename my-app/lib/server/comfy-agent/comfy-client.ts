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
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<ComfyRawResponse> {
  const transport = createPinnedProviderFetch(endpoint);
  let response: Response;
  try {
    response = await transport(new URL(path, endpoint.url), {
      method: init.method ?? "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
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
): Promise<string> {
  const response = await comfyRequest(endpoint, "prompt", {
    method: "POST",
    body: { prompt, client_id: "lunery-agent" },
    timeoutMs: 20_000,
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

export type { ComfySystemStats };
