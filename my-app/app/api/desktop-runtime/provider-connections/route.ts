// BYOK connection metadata route — endpoint + per-capability models per provider.
// Pure metadata, no secrets. Secrets live in the OS keychain via the desktop
// bridge (`/api/desktop-runtime/provider-secret`).
//
// GET  → { connections: { [providerId]: { endpoint, models?, updatedAt } } }
// POST { providerId, endpoint, models? } → 200 { ok: true }
// DELETE { providerId } → 200 { ok: true }

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";
import {
  byokModelInputRoles,
  findByokProvider,
  resolveByokConnectionModels,
  type ByokConnectionModels,
} from "@/lib/byok-providers";
import { validateProviderEndpoint } from "@/lib/server/byok-shared";
import {
  deleteByokConnectionMeta,
  getByokConnectionMeta,
  listByokConnectionMeta,
  setByokConnectionMeta,
} from "@/lib/server/byok-connection-store";

export const dynamic = "force-dynamic";

// Permissive structural schemas: the handlers already tolerate non-string
// values by coercing them to "" via `typeof === "string"` checks, so the
// schema only asserts the body is an object and leaves field typing/coercion
// to the existing semantic checks below.
const providerConnectionPostSchema = z.object({
  providerId: z.unknown().optional(),
  endpoint: z.unknown().optional(),
  models: z.unknown().optional(),
});

const providerConnectionDeleteSchema = z.object({
  providerId: z.string().trim().min(1),
}).strict();

export async function GET() {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;
  return NextResponse.json({ connections: listByokConnectionMeta() });
}

export async function POST(request: NextRequest) {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;

    const body = await parseJsonBody(request, providerConnectionPostSchema);

    const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";

    if (!providerId) {
      return NextResponse.json({ error: "missing_provider_id" }, { status: 400 });
    }
    const meta = findByokProvider(providerId);
    if (!meta) {
      return NextResponse.json({ error: "unknown_provider" }, { status: 400 });
    }
    const finalEndpoint = meta.requiresEndpoint ? endpoint : meta.defaultEndpoint;
    if (!finalEndpoint) {
      return NextResponse.json({ error: "missing_endpoint" }, { status: 400 });
    }

    // Validate at the trust boundary: a stored endpoint is later used as a fetch
    // target with the provider key attached (test-connection + BYOK dispatchers),
    // so reject SSRF-prone hosts before persisting.
    const endpointCheck = await validateProviderEndpoint(finalEndpoint);
    if ("error" in endpointCheck) {
      return NextResponse.json({ error: endpointCheck.error }, { status: 400 });
    }

    // Keep only slots this provider actually exposes so junk roles can't
    // accumulate.
    const requestedModels = resolveByokConnectionModels(body);
    const models: ByokConnectionModels = {};
    for (const role of byokModelInputRoles(meta)) {
      const value = requestedModels?.[role];
      if (value) models[role] = value;
    }
    const hasModel = Object.keys(models).length > 0;

    if (meta.requiresModelId && !hasModel) {
      return NextResponse.json({ error: "missing_model_id" }, { status: 400 });
    }

    try {
      setByokConnectionMeta(providerId, {
        endpoint: endpointCheck.url,
        ...(hasModel ? { models } : {}),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      // Persistence failed (disk full, permissions). The store left memory
      // untouched, so report a real failure instead of a misleading ok:true.
      console.error("[provider-connections] failed to persist:", error);
      return NextResponse.json({ error: "persist_failed" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      connection: getByokConnectionMeta(providerId),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;
    const { providerId } = await parseJsonBody(request, providerConnectionDeleteSchema);
    deleteByokConnectionMeta(providerId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
