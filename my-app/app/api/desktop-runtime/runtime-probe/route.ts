import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { RuntimeProbeResult } from "@/lib/desktop-runtime";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";
import { validateProviderEndpoint } from "@/lib/server/byok-shared";
import { discoverLocalRuntimeModels } from "@/lib/server/runtime-supply";

export const dynamic = "force-dynamic";

// Permissive: the handler coerces a non-string `endpoint` to "" via
// `typeof === "string"` and rejects it with its own 400 below, so the schema
// only asserts the body is an object.
const runtimeProbeBodySchema = z.object({
  endpoint: z.unknown().optional(),
});

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;
  const { url: bridgeUrl, token: bridgeToken } = bridge;

  let endpoint: string;
  try {
    const body = await parseJsonBody(request, runtimeProbeBodySchema);
    endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  } catch (error) {
    return jsonError(error);
  }
  if (!endpoint || endpoint.length > 500) {
    return NextResponse.json({ error: "Provide a valid endpoint." }, { status: 400 });
  }
  const endpointCheck = await validateProviderEndpoint(endpoint);
  if ("error" in endpointCheck || !isLoopbackEndpoint(endpointCheck.url)) {
    return NextResponse.json({ error: "Runtime probe endpoint must be a loopback URL." }, { status: 400 });
  }
  endpoint = endpointCheck.url;

  let bridgeResponse: Response;
  try {
    bridgeResponse = await fetch(`${bridgeUrl}/runtime-probe`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-lunery-desktop-token": bridgeToken,
      },
      body: JSON.stringify({ endpoint }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Network error or timeout — treat as bridge unreachable.
    return NextResponse.json({ error: "Desktop runtime bridge is not available" }, { status: 404 });
  }

  if (!bridgeResponse.ok) {
    return new NextResponse(await bridgeResponse.text(), {
      status: bridgeResponse.status,
      headers: {
        "content-type": bridgeResponse.headers.get("content-type") ?? "application/json",
      },
    });
  }

  const probeResult = (await bridgeResponse.json()) as Omit<RuntimeProbeResult, "models">;

  // Augment with discovered models when the runtime is reachable.
  const models =
    probeResult.reachable && isLoopbackEndpoint(probeResult.endpoint)
      ? await discoverLocalRuntimeModels(probeResult.endpoint)
      : [];

  const merged: RuntimeProbeResult = { ...probeResult, models };

  return NextResponse.json(merged);
}
