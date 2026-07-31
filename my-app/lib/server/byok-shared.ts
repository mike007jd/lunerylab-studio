/**
 * Shared BYOK / image-pipeline helpers.
 *
 * Lifted from per-file duplicates in `byok-image.ts`, `byok-llm.ts`,
 * generation backends and `storage.ts`. Centralising them lets us fix one bug
 * (e.g. a new MIME sniff path, a different polling backoff) in one place.
 *
 * IMPORTANT: keep this server-only. `readByokKey` reads from the desktop
 * bridge over HTTP and must never run in the client bundle.
 */

import "server-only";
import { lookup } from "node:dns/promises";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { BYOK_PROVIDERS } from "@/lib/byok-providers";
import { ApiError } from "@/lib/server/errors";
import { readDesktopStatusRevision } from "@/lib/server/desktop-status-revision";

// ---------------------------------------------------------------------------
// Sleep / polling
// ---------------------------------------------------------------------------

import { sleep } from "@/lib/utils";

/**
 * Generic deadline-bounded poller. The fetcher is called every `intervalMs`
 * until `isDone(result)` returns a truthy "final" value OR the deadline
 * elapses. On deadline a `provider_timeout` ApiError is thrown.
 *
 * Backoff: if `backoffMultiplier` is supplied, the wait grows
 * `interval * multiplier^attempt` up to `maxIntervalMs` (default 10s) with
 * `jitterRatio` of uniform jitter (default 0.2 = ±20%). Default behaviour
 * (no multiplier) is a constant interval to stay compatible with callers that
 * relied on the old fixed-cadence semantics.
 */
export async function pollUntil<T>(params: {
  fetcher: () => Promise<T>;
  isDone: (value: T) => boolean;
  deadlineMs: number;
  intervalMs: number;
  /** Used in the timeout message: "{label} did not complete in time". */
  label?: string;
  backoffMultiplier?: number;
  maxIntervalMs?: number;
  jitterRatio?: number;
  abortSignal?: AbortSignal;
}): Promise<T> {
  const { fetcher, isDone, deadlineMs, intervalMs } = params;
  const deadline = Date.now() + deadlineMs;
  const multiplier = params.backoffMultiplier ?? 1;
  const maxInterval = params.maxIntervalMs ?? 10_000;
  const jitter = params.jitterRatio ?? 0;
  let attempt = 0;
  params.abortSignal?.throwIfAborted();
  let latest = await fetcher();
  while (!isDone(latest)) {
    params.abortSignal?.throwIfAborted();
    if (Date.now() > deadline) {
      throw new ApiError({
        status: 504,
        code: "provider_timeout",
        message: `${params.label ?? "Provider"} did not complete within ${Math.round(
          deadlineMs / 1000,
        )} seconds.`,
        retryable: true,
      });
    }
    const base = Math.min(intervalMs * Math.pow(multiplier, attempt), maxInterval);
    const jitterDelta = jitter > 0 ? base * jitter * (Math.random() * 2 - 1) : 0;
    const wait = Math.max(100, Math.round(base + jitterDelta));
    attempt += 1;
    if (!params.abortSignal) {
      await sleep(wait);
    } else {
      const signal = params.abortSignal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, wait);
        const onAbort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }
    params.abortSignal?.throwIfAborted();
    latest = await fetcher();
  }
  return latest;
}

// ---------------------------------------------------------------------------
// BYOK key retrieval — single canonical path through the desktop bridge.
// SECURITY: the returned key is in-memory only; never log, return, or attach
// it to a thrown error.
// ---------------------------------------------------------------------------

const PROVIDER_ENV_KEYS: Record<string, readonly string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  groq: ["GROQ_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  replicate: ["REPLICATE_API_TOKEN"],
  fal: ["FAL_KEY"],
  together: ["TOGETHER_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  meshy: ["MESHY_API_KEY"],
  tripo: ["TRIPO_API_KEY"],
};

const BYOK_PROVIDER_IDS = new Set(BYOK_PROVIDERS.map(({ id }) => id));

function readByokKeyFromEnv(providerId: string): string | null {
  for (const key of PROVIDER_ENV_KEYS[providerId] ?? []) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return null;
}

function isKnownByokProvider(providerId: string): boolean {
  return BYOK_PROVIDER_IDS.has(providerId);
}

function keychainUnavailableError(providerId: string): ApiError {
  return new ApiError({
    status: 503,
    code: "keychain_unavailable",
    message: `The system keychain is unavailable for provider "${providerId}". Unlock it and retry.`,
    retryable: true,
  });
}

async function readByokKeyFromBridge(providerId: string): Promise<string | null> {
  const bridgeUrl = process.env.LUNERY_DESKTOP_BRIDGE_URL;
  const bridgeToken = process.env.LUNERY_DESKTOP_BRIDGE_TOKEN;
  if (!bridgeUrl || !bridgeToken) {
    if (!isKnownByokProvider(providerId)) return null;
    throw keychainUnavailableError(providerId);
  }

  let response: Response;
  try {
    response = await fetch(`${bridgeUrl}/provider-secret-read`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-lunery-desktop-token": bridgeToken,
      },
      body: JSON.stringify({ providerId }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw keychainUnavailableError(providerId);
  }
  if (response.status === 404) return null;
  // The keychain-read bridge globally throttles secret reads (5/min). A 429 is
  // NOT "no key configured" — collapsing it to null used to surface as
  // missing_api_key, sending users to re-enter a key they already have. Raise a
  // distinct, retryable error so callers can back off and retry instead.
  if (response.status === 429) {
    throw new ApiError({
      status: 429,
      code: "keychain_rate_limited",
      message: `Keychain read rate limit reached for provider "${providerId}". Retry in a moment.`,
      retryable: true,
    });
  }
  if (response.status === 503) {
    throw keychainUnavailableError(providerId);
  }
  if (!response.ok) throw keychainUnavailableError(providerId);

  const data = (await response.json().catch(() => ({}))) as { key?: string };
  const key = data.key?.trim();
  if (!key) throw keychainUnavailableError(providerId);
  return key;
}

export async function tryReadByokKey(providerId: string): Promise<string | null> {
  const envKey = readByokKeyFromEnv(providerId);
  if (envKey) return envKey;
  return readByokKeyFromBridge(providerId);
}

export async function readByokKey(providerId: string): Promise<string> {
  const apiKey = await tryReadByokKey(providerId);
  if (!apiKey) {
    throw new ApiError({
      status: 503,
      code: "missing_api_key",
      message: `Could not retrieve BYOK key for provider "${providerId}".`,
      retryable: false,
    });
  }
  return apiKey;
}

// ---------------------------------------------------------------------------
// Desktop bridge `/status` snapshot.
//
// Consolidates four near-identical fetch+cache copies that used to live in
// runtime-supply.ts, api-keys.ts, byok-image-catalog.ts and video-runtime.ts.
// Local runtimes are dynamic process state and must be fetched fresh. Only the
// configured-provider projection is cached below; secret mutations invalidate
// it through the cross-bundle profile revision marker.
// ---------------------------------------------------------------------------

export type KeychainSecretStatus = "present" | "missing" | "unavailable";

export interface DesktopStatusSnapshot {
  providers: Array<{
    id: string;
    configured: boolean;
    keychain_status: KeychainSecretStatus;
  }>;
  local_runtimes: Array<{ id: string; endpoint: string; status: string }>;
}

interface CachedConfiguredProviderIds {
  value: Set<string>;
  expiresAt: number;
}

const STATUS_CACHE_TTL_MS = 30_000;

let configuredProviderIdsCache: CachedConfiguredProviderIds | null = null;
let configuredProviderIdsRevision = readDesktopStatusRevision();
let configuredProviderIdsEpoch = 0;
let pendingConfiguredProviderIds: {
  epoch: number;
  promise: Promise<Set<string>>;
} | null = null;

function syncDesktopStatusRevision(): void {
  const revision = readDesktopStatusRevision();
  if (revision === null || revision !== configuredProviderIdsRevision) {
    configuredProviderIdsCache = null;
    pendingConfiguredProviderIds = null;
    configuredProviderIdsEpoch += 1;
  }
  configuredProviderIdsRevision = revision;
}

async function fetchDesktopStatusFromBridge(): Promise<DesktopStatusSnapshot | null> {
  const bridgeUrl = process.env.LUNERY_DESKTOP_BRIDGE_URL;
  const bridgeToken = process.env.LUNERY_DESKTOP_BRIDGE_TOKEN;
  if (!bridgeUrl || !bridgeToken) return null;

  try {
    const response = await fetch(`${bridgeUrl}/status`, {
      cache: "no-store",
      headers: { "x-lunery-desktop-token": bridgeToken },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    return (await response.json()) as DesktopStatusSnapshot;
  } catch {
    return null;
  }
}

export async function fetchDesktopStatusSnapshot(): Promise<DesktopStatusSnapshot | null> {
  return fetchDesktopStatusFromBridge();
}

/** Ids of providers the desktop bridge reports as configured. */
export async function fetchConfiguredProviderIds(): Promise<Set<string>> {
  syncDesktopStatusRevision();
  const now = Date.now();
  if (
    configuredProviderIdsRevision !== null &&
    configuredProviderIdsCache &&
    configuredProviderIdsCache.expiresAt > now
  ) {
    return new Set(configuredProviderIdsCache.value);
  }
  if (pendingConfiguredProviderIds?.epoch === configuredProviderIdsEpoch) {
    return new Set(await pendingConfiguredProviderIds.promise);
  }

  const requestEpoch = configuredProviderIdsEpoch;
  const promise = (async () => {
    const snapshot = await fetchDesktopStatusFromBridge();
    if (!snapshot) return new Set<string>();
    const configured = new Set(
      snapshot.providers
        // Native `configured` already combines environment credentials with a
        // present keychain secret. A locked keychain must not hide a provider
        // whose credential is supplied by the environment.
        .filter((provider) => provider.configured)
        .map((provider) => provider.id),
    );
    if (
      requestEpoch === configuredProviderIdsEpoch &&
      configuredProviderIdsRevision !== null
    ) {
      configuredProviderIdsCache = {
        value: configured,
        expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
      };
    }
    return configured;
  })().finally(() => {
    if (pendingConfiguredProviderIds?.epoch === requestEpoch) {
      pendingConfiguredProviderIds = null;
    }
  });

  pendingConfiguredProviderIds = { epoch: requestEpoch, promise };
  return new Set(await promise);
}

const BYOK_MODEL_SELECTION_PREFIX = "byok:";

export function isByokModelSelectionId(modelId?: string): boolean {
  return modelId?.trim().startsWith(BYOK_MODEL_SELECTION_PREFIX) ?? false;
}

/**
 * Parse a `byok:<providerId>:<modelId>` selection string. Returns null for any
 * value that isn't a well-formed BYOK selection.
 */
export function parseByokModelSelection(
  modelId?: string,
): { providerId: string; modelId: string } | null {
  const value = modelId?.trim();
  if (!value?.startsWith(BYOK_MODEL_SELECTION_PREFIX)) return null;
  const rest = value.slice(BYOK_MODEL_SELECTION_PREFIX.length);
  const firstColon = rest.indexOf(":");
  if (firstColon <= 0) return null;
  const providerId = rest.slice(0, firstColon).trim();
  const bareModelId = rest.slice(firstColon + 1).trim();
  if (!providerId || !bareModelId) return null;
  return { providerId, modelId: bareModelId };
}

// ---------------------------------------------------------------------------
// Provider URL boundaries
// ---------------------------------------------------------------------------

const DEFAULT_REMOTE_ASSET_MAX_BYTES = 512 * 1024 * 1024;

function parseHttpUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError({
      status: 502,
      code: "provider_untrusted_url",
      message: `${label} is not a valid URL.`,
      retryable: false,
    });
  }
  if (parsed.protocol !== "https:") {
    throw new ApiError({
      status: 502,
      code: "provider_untrusted_url",
      message: `${label} must use HTTPS.`,
      retryable: false,
    });
  }
  return parsed;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number]; // safe: parts.length === 4 guarded above
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * Expand an IPv6 literal into eight hextets. Accepts compressed forms and the
 * dotted-quad IPv4-mapped suffix (`::ffff:127.0.0.1`).
 */
function parseIpv6Hextets(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let normalized = ip.toLowerCase();
  const dotted = normalized.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = dotted[2]!.split(".").map((part) => Number(part));
    if (
      octets.length !== 4 ||
      octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return null;
    }
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    normalized = `${dotted[1]}${hi}:${lo}`;
  }

  if (normalized.includes("::")) {
    const [left = "", right = ""] = normalized.split("::");
    const leftParts = left ? left.split(":") : [];
    const rightParts = right ? right.split(":") : [];
    const missing = 8 - leftParts.length - rightParts.length;
    if (missing < 0) return null;
    normalized = [...leftParts, ...Array(missing).fill("0"), ...rightParts].join(":");
  }

  const parts = normalized.split(":");
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }
  return parts.map((part) => Number.parseInt(part, 16));
}

function ipv4FromMappedIpv6(hextets: number[]): string | null {
  // ::ffff:0:0/96 — hextets 0-4 zero, hextet 5 = 0xffff.
  if (
    hextets.length !== 8 ||
    hextets[0] !== 0 ||
    hextets[1] !== 0 ||
    hextets[2] !== 0 ||
    hextets[3] !== 0 ||
    hextets[4] !== 0 ||
    hextets[5] !== 0xffff
  ) {
    return null;
  }
  const hi = hextets[6]!;
  const lo = hextets[7]!;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function ipv4FromWellKnownNat64(hextets: number[]): string | null {
  // 64:ff9b::/96 is the globally reachable NAT64 well-known prefix. Its
  // embedded IPv4 destination still must be public.
  if (
    hextets.length !== 8 ||
    hextets[0] !== 0x0064 ||
    hextets[1] !== 0xff9b ||
    hextets[2] !== 0 ||
    hextets[3] !== 0 ||
    hextets[4] !== 0 ||
    hextets[5] !== 0
  ) {
    return null;
  }
  const hi = hextets[6]!;
  const lo = hextets[7]!;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isGloballyReachableIetfAssignment(hextets: number[]): boolean {
  if (hextets[0] !== 0x2001) return false;
  const second = hextets[1]!;

  // More-specific globally reachable allocations inside IANA's otherwise
  // non-global 2001::/23 protocol block.
  if (
    second === 0x0001 &&
    hextets.slice(2, 7).every((part) => part === 0) &&
    hextets[7]! >= 1 &&
    hextets[7]! <= 3
  ) {
    return true;
  }
  if (second === 0x0003) return true; // AMT 2001:3::/32
  if (second === 0x0004 && hextets[2] === 0x0112) return true; // AS112-v6 /48
  if (second >= 0x0020 && second <= 0x002f) return true; // ORCHIDv2 /28
  if (second >= 0x0030 && second <= 0x003f) return true; // DETs /28
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const hextets = parseIpv6Hextets(ip);
  if (!hextets) return true;

  // Unspecified :: and loopback ::1.
  if (hextets.every((part) => part === 0)) return true;
  if (hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1) return true;

  const mappedIpv4 = ipv4FromMappedIpv6(hextets);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);

  const nat64Ipv4 = ipv4FromWellKnownNat64(hextets);
  if (nat64Ipv4) return isPrivateIpv4(nat64Ipv4);

  const first = hextets[0]!;
  const second = hextets[1]!;

  // Positive global-unicast classification: ordinary public IPv6 lives in
  // 2000::/3. Everything outside it is special/non-global unless explicitly
  // accepted above (the public NAT64 well-known prefix).
  if ((first & 0xe000) !== 0x2000) return true;

  // IANA special-purpose exceptions inside 2000::/3:
  // - 2001::/23: protocol assignments (Teredo, benchmarking, ORCHID, etc.)
  // - 2001:db8::/32 and 3fff::/20: documentation
  // - 2002::/16: deprecated 6to4 transition addressing
  if (first === 0x2001 && second <= 0x01ff) {
    return !isGloballyReachableIetfAssignment(hextets);
  }
  if (first === 0x2001 && second === 0x0db8) return true;
  if (first === 0x2002) return true;
  if (first === 0x3fff && (second & 0xf000) === 0) return true;

  return false;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (!net.isIPv6(ip)) return true;
  return isPrivateIpv6(ip);
}

function isLoopbackIp(ip: string): boolean {
  if (net.isIPv4(ip)) return ip.split(".")[0] === "127";
  const hextets = parseIpv6Hextets(ip);
  if (!hextets) return false;
  if (hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1) return true;
  const mappedIpv4 = ipv4FromMappedIpv6(hextets);
  return mappedIpv4 ? mappedIpv4.split(".")[0] === "127" : false;
}

function normalizeEndpointHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

function isBlockedMetadataHost(hostname: string): boolean {
  return hostname === "metadata" || hostname === "metadata.google.internal";
}

async function resolveEndpointHost(hostname: string): Promise<Array<{ address: string; family: number }> | null> {
  const directIp = net.isIP(hostname);
  if (directIp) return [{ address: hostname, family: directIp }];
  try {
    return await lookup(hostname, { all: true, verbatim: false });
  } catch {
    return null;
  }
}

export interface ValidatedProviderEndpoint {
  url: string;
  records: Array<{ address: string; family: number }>;
}

export function selectPinnedLookupRecords(
  records: Array<{ address: string; family: number }>,
  options: number | string | { all?: boolean; family?: number | string },
): Array<{ address: string; family: number }> {
  const rawFamily =
    typeof options === "object" ? options.family : options;
  const requestedFamily =
    rawFamily === "IPv4" ? 4 : rawFamily === "IPv6" ? 6 : rawFamily;
  const candidates =
    requestedFamily === 4 || requestedFamily === 6
      ? records.filter((record) => record.family === requestedFamily)
      : records;
  if (typeof options === "object" && options.all) return candidates;
  return candidates.slice(0, 1);
}

/**
 * Validate a user-supplied BYOK provider endpoint at the trust boundary
 * (connection write + test-connection + generation dispatch). Loopback is
 * allowed (the local OpenAI-compatible / Ollama case); public endpoints must be
 * HTTPS, and all DNS answers must stay public so a stored hostname can't turn
 * into a private-host SSRF / key-exfiltration primitive. Returns the normalized
 * URL or an error message.
 */
export async function validateProviderEndpoint(
  value: string,
): Promise<ValidatedProviderEndpoint | { error: string }> {
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
  // Query/fragment must not survive into the trusted base URL: adapters append
  // API paths with string joins, and a `?` / `#` would turn those paths into
  // query or fragment text instead of path segments.
  if (parsed.search || parsed.hash) {
    return { error: "Endpoint must not include a query or fragment." };
  }
  const host = normalizeEndpointHostname(parsed.hostname);
  if (isBlockedMetadataHost(host)) {
    return { error: "Endpoint host is not allowed." };
  }

  const records = await resolveEndpointHost(host);
  if (!records || records.length === 0) {
    return { error: "Endpoint host could not be resolved." };
  }

  const allLoopback = records.every((record) => isLoopbackIp(record.address));
  if (!allLoopback && records.some((record) => isPrivateIp(record.address))) {
    return { error: "Endpoint points to a private or link-local address." };
  }

  if (parsed.protocol === "http:" && !allLoopback) {
    return { error: "Endpoint must use https unless it points to loopback." };
  }
  return { url: parsed.toString(), records };
}

export async function requireValidatedProviderEndpoint(
  value: string,
): Promise<ValidatedProviderEndpoint> {
  const endpointCheck = await validateProviderEndpoint(value);
  if ("error" in endpointCheck) {
    throw new ApiError({
      status: 400,
      code: "invalid_provider_endpoint",
      message: endpointCheck.error,
      retryable: false,
    });
  }
  return endpointCheck;
}

function isPathWithinEndpoint(targetPath: string, endpointPath: string): boolean {
  const basePath = endpointPath.replace(/\/+$/, "");
  return basePath === "" || targetPath === basePath || targetPath.startsWith(`${basePath}/`);
}

function createPinnedDnsLookup(
  records: Array<{ address: string; family: number }>,
) {
  return (
    _hostname: string,
    options: Parameters<typeof selectPinnedLookupRecords>[1],
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string,
      family: number,
    ) => void,
  ) => {
    const selectedRecords = selectPinnedLookupRecords(records, options);
    const record = selectedRecords[0];
    if (!record) {
      callback(new Error("Validated provider endpoint has no pinned address."), "", 4);
      return;
    }
    if (typeof options === "object" && options.all) {
      (
        callback as unknown as (
          error: NodeJS.ErrnoException | null,
          addresses: Array<{ address: string; family: number }>,
        ) => void
      )(null, selectedRecords);
    } else {
      callback(null, record.address, record.family);
    }
  };
}

/**
 * Return a Fetch-compatible transport whose socket lookup is pinned to the
 * public/loopback answers validated above. The requested origin and base path
 * cannot change, and redirects are returned to the caller instead of followed,
 * so credentials never cross the validated trust boundary.
 */
export function createPinnedProviderFetch(
  endpoint: ValidatedProviderEndpoint,
): typeof fetch {
  const baseUrl = new URL(endpoint.url);
  const lookup = createPinnedDnsLookup(endpoint.records);

  return async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, { ...init, redirect: "manual" });
    const targetUrl = new URL(request.url);
    if (
      targetUrl.origin !== baseUrl.origin ||
      !isPathWithinEndpoint(targetUrl.pathname, baseUrl.pathname)
    ) {
      throw new ApiError({
        status: 400,
        code: "invalid_provider_endpoint",
        message: "Provider request escaped the validated endpoint.",
        retryable: false,
      });
    }

    const transport = targetUrl.protocol === "https:" ? https : http;
    return new Promise<Response>((resolve, reject) => {
      const requestHeaders = Object.fromEntries(request.headers.entries());
      requestHeaders["accept-encoding"] ??= "identity";
      const outgoing = transport.request(
        targetUrl,
        {
          method: request.method,
          headers: requestHeaders,
          signal: request.signal,
          lookup,
        },
        (incoming) => {
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index];
            const value = incoming.rawHeaders[index + 1];
            if (name && value !== undefined) headers.append(name, value);
          }
          const hasBody =
            request.method !== "HEAD" &&
            incoming.statusCode !== 204 &&
            incoming.statusCode !== 205 &&
            incoming.statusCode !== 304;
          resolve(
            new Response(
              hasBody ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null,
              {
                status: incoming.statusCode ?? 500,
                statusText: incoming.statusMessage,
                headers,
              },
            ),
          );
        },
      );
      outgoing.on("error", reject);

      void (async () => {
        try {
          if (request.body) {
            const reader = request.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = value;
              if (!outgoing.write(chunk)) {
                await new Promise<void>((resume) => outgoing.once("drain", resume));
              }
            }
          }
          outgoing.end();
        } catch (error) {
          outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  };
}

async function resolvePublicHost(hostname: string): Promise<Array<{ address: string; family: number }>> {
  // WHATWG URL hostnames keep IPv6 literals bracketed; strip before isIP/DNS.
  const host = normalizeEndpointHostname(hostname);
  const directIp = net.isIP(host);
  const records = directIp
    ? [{ address: host, family: directIp }]
    : await lookup(host, { all: true, verbatim: false });
  if (records.length === 0 || records.some((record) => isPrivateIp(record.address))) {
    throw new ApiError({
      status: 502,
      code: "provider_untrusted_url",
      message: "Provider returned a private or local download host.",
      retryable: false,
    });
  }
  return records;
}

function requestPinnedHttps(
  url: URL,
  records: Array<{ address: string; family: number }>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        timeout: timeoutMs,
        signal: abortSignal,
        lookup: createPinnedDnsLookup(records),
      },
      resolve,
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end();
  });
}

async function readResponseBytes(
  response: IncomingMessage,
  {
    label,
    maxBytes,
  }: {
    label: string;
    maxBytes: number;
  },
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    abortSignal?.throwIfAborted();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      response.destroy();
      throw new ApiError({
        status: 502,
        code: "provider_asset_too_large",
        message: `${label} exceeded the allowed download limit.`,
        retryable: false,
      });
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function headerString(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

export async function downloadRemoteBytes(
  url: string,
  options?: {
    timeoutMs?: number;
    maxBytes?: number;
    fallbackMimeType?: string;
    label?: string;
    abortSignal?: AbortSignal;
  },
): Promise<{ bytes: Buffer; mimeType: string }> {
  options?.abortSignal?.throwIfAborted();
  const label = options?.label ?? "Provider asset URL";
  const parsed = parseHttpUrl(url, label);

  const maxBytes = options?.maxBytes ?? DEFAULT_REMOTE_ASSET_MAX_BYTES;
  let current = parsed;
  let response: IncomingMessage | null = null;
  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      options?.abortSignal?.throwIfAborted();
      const records = await resolvePublicHost(current.hostname);
      options?.abortSignal?.throwIfAborted();
      response = await requestPinnedHttps(
        current,
        records,
        options?.timeoutMs ?? 60_000,
        options?.abortSignal,
      );
      const statusCode = response.statusCode ?? 0;
      if (![301, 302, 303, 307, 308].includes(statusCode)) break;
      const location = headerString(response.headers, "location");
      response.destroy();
      if (!location) break;
      if (redirects === 5) {
        response = null;
        break;
      }
      current = parseHttpUrl(new URL(location, current).toString(), `${label} redirect`);
      response = null;
    }
  } catch (error) {
    options?.abortSignal?.throwIfAborted();
    if (error instanceof ApiError) throw error;
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `Could not download ${label.toLowerCase()}.`,
      retryable: true,
    });
  }
  if (!response) {
    throw new ApiError({
      status: 502,
      code: "provider_untrusted_url",
      message: `${label} followed too many redirects.`,
      retryable: false,
    });
  }
  const statusCode = response.statusCode ?? 0;
  if (statusCode < 200 || statusCode >= 300) {
    response.destroy();
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `Could not download ${label.toLowerCase()} (HTTP ${statusCode}).`,
      retryable: true,
    });
  }

  const lengthHeader = headerString(response.headers, "content-length");
  const contentLength = lengthHeader ? Number(lengthHeader) : NaN;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.destroy();
    throw new ApiError({
      status: 502,
      code: "provider_asset_too_large",
      message: "Provider asset is larger than the allowed download limit.",
      retryable: false,
    });
  }

  const bytes = await readResponseBytes(response, { label, maxBytes }, options?.abortSignal);
  const headerMime = headerString(response.headers, "content-type")?.split(";")[0]?.trim();
  return {
    bytes,
    mimeType: headerMime || sniffImageMime(bytes) || options?.fallbackMimeType || "application/octet-stream",
  };
}

// ---------------------------------------------------------------------------
// Image MIME sniffing — PNG / JPEG / WebP / GIF magic bytes
// ---------------------------------------------------------------------------

/**
 * Sniff a `Buffer`'s leading bytes and return the matching image MIME, or
 * `null` if no signature matches.
 *
 * Used in three places that historically each had a slightly different copy:
 *  - byok-image.ts (returned "image/png" as fallback)
 *  - storage.ts    (returned null on unknown — preserved here)
 *  - generation backends (returned "image/png" as fallback)
 *
 * Callers that want the old "image/png" default should fall back themselves:
 *   `sniffImageMime(buf) ?? "image/png"`.
 */
export function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (buffer.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  return null;
}

// ---------------------------------------------------------------------------
// Image decoding / fetching
// ---------------------------------------------------------------------------

export interface DecodedImage {
  bytes: Buffer;
  mimeType: string;
}

/** Encode raw bytes into a `data:<mime>;base64,...` URL. */
export function bufferToDataUrl(buf: Buffer, mime = "image/png"): string {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/**
 * Download a remote image URL into bytes + MIME. 60s timeout (overrideable),
 * trusts the response Content-Type header when present, falls back to sniff.
 */
export async function downloadImageFromUrl(
  url: string,
  options?: { timeoutMs?: number },
): Promise<DecodedImage> {
  const { bytes, mimeType: headerMime } = await downloadRemoteBytes(url, {
    timeoutMs: options?.timeoutMs ?? 60_000,
    maxBytes: 80 * 1024 * 1024,
    fallbackMimeType: "image/png",
    label: "Generated image URL",
  });
  const mimeType = sniffImageMime(bytes) || headerMime || "image/png";
  return { bytes, mimeType };
}

// ---------------------------------------------------------------------------
// Aspect-ratio → size map
// ---------------------------------------------------------------------------

export interface AspectSize {
  width: number;
  height: number;
  /** "WxH" string accepted by the OpenAI images.generations `size` param. */
  size: `${number}x${number}`;
}

const ASPECT_TABLE: Record<string, AspectSize> = {
  "1:1": { width: 1024, height: 1024, size: "1024x1024" },
  "16:9": { width: 1536, height: 1024, size: "1536x1024" },
  "9:16": { width: 1024, height: 1536, size: "1024x1536" },
  "4:3": { width: 1280, height: 960, size: "1280x960" },
  "3:4": { width: 960, height: 1280, size: "960x1280" },
  "3:2": { width: 1536, height: 1024, size: "1536x1024" },
  "2:3": { width: 1024, height: 1536, size: "1024x1536" },
};

/**
 * Merge an optional caller cancel signal with an internal request timeout so a
 * user "Stop" actually aborts the in-flight provider request instead of waiting
 * for the timeout to fire. Returns the bare timeout signal when no caller signal
 * is supplied. (Node 22 `AbortSignal.any`.)
 */
export function withTimeoutSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

/** The aspect ratios the pipeline can actually honor — the whitelist source. */
export const SUPPORTED_ASPECT_RATIOS: readonly string[] = Object.keys(ASPECT_TABLE);

/** Whether a "W:H" ratio is one the pipeline supports (vs. a silent 1:1 fallback). */
export function isSupportedAspectRatio(ratio: string): boolean {
  return Object.prototype.hasOwnProperty.call(ASPECT_TABLE, ratio);
}

/**
 * Resolve a "W:H" ratio string to width/height/size. Falls back to 1:1 for
 * absent/unknown ratios — callers that must reject an unsupported ratio should
 * validate with `isSupportedAspectRatio` at the request boundary first.
 */
export function aspectRatioToSize(ratio: string | undefined): AspectSize {
  return ASPECT_TABLE[ratio ?? ""] ?? ASPECT_TABLE["1:1"]!; // safe: "1:1" is a static key present in ASPECT_TABLE
}

/**
 * Parse a request's aspect-ratio field. Absent/blank → undefined (use the
 * model default). A provided ratio that the pipeline can't honor (malformed or
 * unsupported, e.g. "2:1") is rejected with a 400 instead of silently snapping
 * to 1:1 — the user's request and the output must match.
 */
export function parseRequestedAspectRatio(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const value = String(raw).trim();
  if (!value) return undefined;
  if (!isSupportedAspectRatio(value)) {
    throw new ApiError({
      status: 400,
      code: "unsupported_aspect_ratio",
      message: `Unsupported aspect ratio "${value}". Supported: ${SUPPORTED_ASPECT_RATIOS.join(", ")}.`,
      retryable: false,
    });
  }
  return value;
}
