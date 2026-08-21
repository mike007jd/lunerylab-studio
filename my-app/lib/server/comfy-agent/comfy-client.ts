// Pinned-fetch client for the attached ComfyUI server and its Manager plugin.
//
// Every request goes to the already-validated active endpoint through the
// DNS-pinned transport. Manager routes are best-effort: deployments without
// ComfyUI-Manager answer 404, which the agent surfaces as "not available"
// instead of an error.

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

const MANAGER_INSTALLED_PATHS = ["customnode/installed", "api/customnode/installed"];
const MANAGER_INSTALL_PATHS = ["api/manager/queue/install", "manager/queue/install"];
const MANAGER_REBOOT_PATHS = ["api/manager/reboot", "manager/reboot"];

function extractNodeNames(json: unknown): string[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as Record<string, unknown>).custom_nodes)
      ? ((json as Record<string, unknown>).custom_nodes as unknown[])
      : [];
  const names: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name =
      typeof record.name === "string"
        ? record.name
        : typeof record.title === "string"
          ? record.title
          : typeof record.cnr_id === "string"
            ? record.cnr_id
            : null;
    if (name) names.push(name);
  }
  return names;
}

export interface ManagerNodeList {
  available: boolean;
  nodes: string[];
}

export async function listManagerCustomNodes(
  endpoint: ValidatedComfyEndpoint,
): Promise<ManagerNodeList> {
  for (const path of MANAGER_INSTALLED_PATHS) {
    const response = await comfyRequest(endpoint, path, { timeoutMs: 8_000 });
    if (response.ok && response.json !== null) {
      return { available: true, nodes: extractNodeNames(response.json) };
    }
  }
  return { available: false, nodes: [] };
}

export async function installManagerCustomNode(
  endpoint: ValidatedComfyEndpoint,
  name: string,
): Promise<{ ok: boolean; detail: string }> {
  for (const path of MANAGER_INSTALL_PATHS) {
    const response = await comfyRequest(endpoint, path, {
      method: "POST",
      body: { name },
      timeoutMs: 30_000,
    });
    if (response.status === 404) continue;
    if (response.ok) {
      return { ok: true, detail: "Install queued on the server (download runs in its background)." };
    }
    return {
      ok: false,
      detail: `Manager refused the install (HTTP ${response.status}).`,
    };
  }
  return { ok: false, detail: "ComfyUI-Manager is not available on this server." };
}

export async function rebootViaManager(
  endpoint: ValidatedComfyEndpoint,
): Promise<{ ok: boolean; detail: string }> {
  for (const path of MANAGER_REBOOT_PATHS) {
    const response = await comfyRequest(endpoint, path, {
      method: "POST",
      timeoutMs: 10_000,
    });
    if (response.status === 404) continue;
    return {
      ok: response.ok,
      detail: response.ok
        ? "Reboot requested. The server restarts in the background; test the connection in a moment."
        : `Manager refused the reboot (HTTP ${response.status}).`,
    };
  }
  return { ok: false, detail: "ComfyUI-Manager is not available on this server." };
}

export type { ComfySystemStats };
