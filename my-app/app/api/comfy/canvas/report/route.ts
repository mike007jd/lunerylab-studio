// Canvas graph beacon target.
//
// The ComfyUI canvas window (origin = the loopback relay, 127.0.0.1:8189-8199)
// pushes its serialized graph here so the ComfyUI agent can read it. This is
// the one endpoint a remote-origin page may call, so it carries explicit CORS
// grants scoped to relay origins only — every other origin is rejected.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import { parseJsonBody } from "@/lib/server/http-validation";
import {
  isComfyRelayOrigin,
  storeComfyCanvasReport,
} from "@/lib/server/comfy-canvas-report";

export const dynamic = "force-dynamic";

const canvasReportSchema = z
  .object({
    prompt: z.record(z.string(), z.unknown()),
    workflow: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!isComfyRelayOrigin(origin) || !isDesktopRuntime()) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!isComfyRelayOrigin(origin) || !isDesktopRuntime()) {
    return new NextResponse(null, { status: 403 });
  }
  try {
    const body = await parseJsonBody(request, canvasReportSchema);
    storeComfyCanvasReport({ prompt: body.prompt, workflow: body.workflow });
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400, headers: corsHeaders(origin) });
  }
}
