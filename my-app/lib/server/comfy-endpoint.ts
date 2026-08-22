// ComfyUI endpoint trust boundary.
//
// A ComfyUI connection differs from a BYOK provider in one way that shapes
// validation: ComfyUI serves plain HTTP on home networks (LAN / Tailscale / a
// remote box reached over SSH), and no credentials are ever attached to
// requests. So http is allowed for loopback AND private/resolvable-private
// hosts, while public hosts must still be https. Everything else mirrors
// validateProviderEndpoint: no URL credentials, no query/fragment, no cloud
// metadata hosts, DNS must resolve, and mixed public+private answers are
// rejected so a stored hostname cannot be turned into an internal-probe
// primitive.

import "server-only";
import {
  createPinnedProviderFetch,
  isBlockedMetadataHost,
  isLoopbackIp,
  isPrivateIp,
  normalizeEndpointHostname,
  resolveEndpointHost,
  type ValidatedProviderEndpoint,
} from "@/lib/server/byok-shared";
import type { ComfySystemStats } from "@/lib/comfy-attach";

export type ValidatedComfyEndpoint = ValidatedProviderEndpoint;
export type { ComfySystemStats };

export async function validateComfyEndpoint(
  value: string,
): Promise<ValidatedComfyEndpoint | { error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: "Endpoint is not a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "Endpoint must use http or https." };
  }
  if (parsed.username || parsed.password) {
    return { error: "Endpoint must not include URL credentials." };
  }
  if (parsed.search || parsed.hash) {
    return { error: "Endpoint must not include a query or fragment." };
  }
  const host = normalizeEndpointHostname(parsed.hostname);
  if (!host) {
    return { error: "Endpoint host is missing." };
  }
  if (isBlockedMetadataHost(host)) {
    return { error: "Endpoint host is not allowed." };
  }

  const records = await resolveEndpointHost(host);
  if (!records || records.length === 0) {
    return { error: "Endpoint host could not be resolved." };
  }

  // All answers must stay on one side of the public/private line so a hostname
  // cannot be re-resolved into an internal address after validation.
  const allPrivate = records.every(
    (record) => isLoopbackIp(record.address) || isPrivateIp(record.address),
  );
  if (!allPrivate && records.some((record) => isPrivateIp(record.address))) {
    return { error: "Endpoint resolves to both public and private addresses." };
  }

  if (parsed.protocol === "http:" && !allPrivate) {
    return {
      error: "Endpoint must use https unless it points to this machine or a private network host.",
    };
  }
  return { url: parsed.toString(), records };
}

// ---------------------------------------------------------------------------
// ComfyUI HTTP client (test + sync)
// ---------------------------------------------------------------------------

interface RawSystemStats {
  system?: {
    comfyui_version?: unknown;
    required_frontend_version?: unknown;
    frontend_version?: unknown;
    python_version?: unknown;
    pytorch_version?: unknown;
    os?: unknown;
    ram_total?: unknown;
    ram_free?: unknown;
  };
  devices?: Array<{
    name?: unknown;
    type?: unknown;
    vram_total?: unknown;
    vram_free?: unknown;
  }>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function parseSystemStats(raw: RawSystemStats): ComfySystemStats {
  const device = Array.isArray(raw.devices) ? raw.devices[0] : undefined;
  const frontendVersion =
    optionalString(raw.system?.required_frontend_version) ??
    optionalString(raw.system?.frontend_version);
  return {
    comfyUiVersion: optionalString(raw.system?.comfyui_version),
    frontendVersion,
    pythonVersion: optionalString(raw.system?.python_version),
    pytorchVersion: optionalString(raw.system?.pytorch_version),
    os: optionalString(raw.system?.os),
    // ComfyUI reports RAM inside `system` as ram_total / ram_free.
    ramTotalBytes: optionalBytes(raw.system?.ram_total),
    ramFreeBytes: optionalBytes(raw.system?.ram_free),
    deviceName: optionalString(device?.name),
    deviceType: optionalString(device?.type),
    vramTotalBytes: optionalBytes(device?.vram_total),
    vramFreeBytes: optionalBytes(device?.vram_free),
  };
}

export class ComfyEndpointError extends Error {
  readonly code:
    | "comfy_unreachable"
    | "comfy_unexpected_status"
    | "comfy_invalid_response";

  constructor(code: ComfyEndpointError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "ComfyEndpointError";
  }
}

async function comfyFetch(
  endpoint: ValidatedComfyEndpoint,
  path: string,
  timeoutMs: number,
): Promise<unknown> {
  const transport = createPinnedProviderFetch(endpoint);
  let response: Response;
  try {
    response = await transport(new URL(path, endpoint.url), {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new ComfyEndpointError("comfy_unreachable", "ComfyUI did not respond in time.");
    }
    const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
    throw new ComfyEndpointError("comfy_unreachable", `ComfyUI is not reachable.${detail}`);
  }
  if (!response.ok) {
    throw new ComfyEndpointError(
      "comfy_unexpected_status",
      `ComfyUI responded with HTTP ${response.status}.`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ComfyEndpointError(
      "comfy_invalid_response",
      "Endpoint did not return ComfyUI JSON.",
    );
  }
}

export async function fetchComfySystemStats(
  endpoint: ValidatedComfyEndpoint,
  { timeoutMs = 8000 }: { timeoutMs?: number } = {},
): Promise<ComfySystemStats> {
  const raw = (await comfyFetch(endpoint, "system_stats", timeoutMs)) as RawSystemStats;
  return parseSystemStats(raw);
}

/** Model folders pulled during a sync. Folders absent on the server stay empty. */
export const COMFY_MODEL_FOLDERS = [
  "checkpoints",
  "diffusion_models",
  "vae",
  "loras",
  "text_encoders",
  "clip",
  "clip_vision",
  "controlnet",
  "upscale_models",
] as const;

export type ComfyModelFolder = (typeof COMFY_MODEL_FOLDERS)[number];

export async function fetchComfyModelFolder(
  endpoint: ValidatedComfyEndpoint,
  folder: ComfyModelFolder,
  { timeoutMs = 8000 }: { timeoutMs?: number } = {},
): Promise<string[]> {
  const raw = await comfyFetch(endpoint, `models/${folder}`, timeoutMs);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}
