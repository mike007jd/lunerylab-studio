// Probe a BYOK provider with a cheap call to verify the API key is valid.
// This is a *credentials* check (reachability + auth), NOT a model-capability
// test — surfaced in Settings as "Test credentials" so users don't read a
// green result as "this model works".
//
// POST body: { providerId: string, apiKey?: string, endpoint?: string }
// Response:  { ok: boolean, latency_ms: number, error?: string }
//
// Probes:
//   openai            → GET /v1/models
//   anthropic         → GET /v1/models with x-api-key + anthropic-version
//   gemini            → GET /v1beta/models with x-goog-api-key
//   openrouter        → GET /api/v1/models with Authorization
//   minimax           → GET /v1/models with Authorization
//   replicate         → GET /v1/account
//   fal               → GET (queue url) /info — no list endpoint, instead
//                       resolve identity via auth-protected /requests/health
//   together          → GET /v1/models
//   fireworks         → GET /v1/models
//   meshy             → GET /openapi/v1/balance
//   tripo             → GET /task/{probe-id}; 404 means auth worked and task is absent
//   openai-compatible → GET {endpoint}/models
//
// Timeout 8s, errors are mapped to a string.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";
import { findByokProvider } from "@/lib/byok-providers";
import { getByokConnectionMeta } from "@/lib/server/byok-connection-store";
import { tryReadByokKey, validateProviderEndpoint } from "@/lib/server/byok-shared";

export const dynamic = "force-dynamic";

// Permissive: the handler coerces a non-string `providerId` to "" via
// `typeof === "string"` and rejects it with its own 400 below, so the schema
// only asserts the body is an object.
const testConnectionBodySchema = z.object({
  providerId: z.unknown().optional(),
  apiKey: z.unknown().optional(),
  endpoint: z.unknown().optional(),
});

interface ProbeResult {
  ok: boolean;
  status: number;
  error?: string;
}

interface ProviderProbeSpec {
  path: string;
  headers: (apiKey: string) => Record<string, string>;
  okStatuses?: readonly number[];
}

const bearerAuth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` });

const PROVIDER_PROBES: Record<string, ProviderProbeSpec> = {
  openai: { path: "/models", headers: bearerAuth },
  anthropic: {
    path: "/v1/models",
    headers: (apiKey) => ({
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
  },
  gemini: { path: "/v1beta/models", headers: (apiKey) => ({ "x-goog-api-key": apiKey }) },
  openrouter: { path: "/models", headers: bearerAuth },
  minimax: { path: "/models", headers: bearerAuth },
  replicate: { path: "/account", headers: (apiKey) => ({ Authorization: `Token ${apiKey}` }) },
  fal: { path: "/", headers: (apiKey) => ({ Authorization: `Key ${apiKey}` }) },
  together: { path: "/models", headers: bearerAuth },
  fireworks: { path: "/models", headers: bearerAuth },
  "openai-compatible": { path: "/models", headers: bearerAuth },
  meshy: { path: "/v1/balance", headers: bearerAuth },
  tripo: { path: "/task/lunery-connection-probe", headers: bearerAuth, okStatuses: [404] },
};

const DEFAULT_PROBE: ProviderProbeSpec = { path: "/models", headers: bearerAuth };

function probeUrl(endpoint: string, path: string): string {
  return path === "/" ? `${endpoint}/` : `${endpoint}${path}`;
}

async function probe(
  url: string,
  headers: Record<string, string>,
  okStatuses: readonly number[] = [200],
): Promise<ProbeResult> {
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok || okStatuses.includes(response.status)) return { ok: true, status: response.status };
    const text = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: text.slice(0, 200) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : "network error",
    };
  }
}

async function runProbe(
  providerId: string,
  apiKey: string,
  endpointOverride?: string,
): Promise<ProbeResult> {
  const meta = findByokProvider(providerId);
  if (!meta) return { ok: false, status: 0, error: "unknown provider" };
  const connection = getByokConnectionMeta(providerId);
  // Re-validate before attaching the API key — never send the key to an
  // SSRF-prone / private host even if a bad endpoint slipped into the store.
  const endpointCheck = await validateProviderEndpoint(endpointOverride?.trim() || connection?.endpoint?.trim() || meta.defaultEndpoint);
  if ("error" in endpointCheck) {
    return { ok: false, status: 0, error: endpointCheck.error };
  }
  const endpoint = endpointCheck.url.replace(/\/+$/, "");

  const spec = PROVIDER_PROBES[providerId] ?? DEFAULT_PROBE;
  return probe(probeUrl(endpoint, spec.path), spec.headers(apiKey), spec.okStatuses);
}

export async function POST(request: NextRequest) {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  let body: z.infer<typeof testConnectionBodySchema>;
  try {
    body = await parseJsonBody(request, testConnectionBodySchema);
  } catch (error) {
    return jsonError(error);
  }
  const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
  if (!providerId) {
    return NextResponse.json({ ok: false, error: "missing_provider_id" }, { status: 400 });
  }
  if (!findByokProvider(providerId)) {
    return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 400 });
  }

  const draftApiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const endpointOverride = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  const apiKey = draftApiKey || await tryReadByokKey(providerId);
  if (!apiKey) {
    return NextResponse.json({
      ok: false,
      latency_ms: 0,
      error: "Enter an API key, then test.",
    });
  }

  const startedAt = Date.now();
  const result = await runProbe(providerId, apiKey, endpointOverride);
  const latency_ms = Date.now() - startedAt;
  return NextResponse.json({
    ok: result.ok,
    latency_ms,
    error: result.ok ? undefined : result.error || `HTTP ${result.status}`,
  });
}
