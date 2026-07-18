import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { findHfModelEntry } from "@/lib/hf-model-catalog";
import {
  bridgeErrorText,
  proxyToBridge,
  requireDesktopBridge,
  startBridgeDownloadJob,
} from "@/lib/server/desktop-bridge";
import { modelCachePath } from "@/lib/server/imported-model-registry";
import { jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";

export const dynamic = "force-dynamic";

const hfDownloadBodySchema = z.object({
  modelId: z.string().optional(),
  file: z.string().optional(),
});

/**
 * POST /api/desktop-runtime/hf-download
 * Body: { modelId: string }
 * Resolves dest path, starts a bridge download job, returns { jobId }.
 */
export async function POST(request: NextRequest) {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  let body: z.infer<typeof hfDownloadBodySchema>;
  try {
    body = await parseJsonBody(request, hfDownloadBodySchema);
  } catch (error) {
    return jsonError(error);
  }

  const { modelId, file } = body;
  if (!modelId) {
    return NextResponse.json({ error: "modelId is required" }, { status: 400 });
  }

  const entry = findHfModelEntry(modelId);
  if (!entry) {
    return NextResponse.json(
      { error: `Unknown model id: ${modelId}` },
      { status: 404 },
    );
  }
  if (entry.lifecycleStatus === "planned") {
    return NextResponse.json(
      { error: `Model ${modelId} is current but not installable until its local runtime path is verified.` },
      { status: 409 },
    );
  }

  // Single-file callers send NO `file` → main file (byte-identical to before).
  // Multi-file callers (the FLUX kit) send `file` to pick the main file or one
  // companion; each is still an ordinary single-file resumable bridge job.
  let targetUrl: string;
  let targetName: string;
  let targetSha: string | null;
  if (!file || file === entry.fileName) {
    targetUrl = entry.downloadUrl;
    targetName = entry.fileName || entry.id;
    targetSha = entry.sha256;
  } else {
    const companion = entry.companions?.find((c) => c.fileName === file);
    if (!companion) {
      return NextResponse.json(
        { error: `File ${file} is not part of model ${modelId}` },
        { status: 404 },
      );
    }
    targetUrl = companion.downloadUrl;
    targetName = companion.fileName;
    targetSha = companion.sha256;
  }

  // Dest path: <Lunery profile>/models/<runtimeTarget>/<targetName> — one
  // shared convention with the engine-start and catalog-install-status sites.
  const dest = modelCachePath(entry.runtimeTarget, targetName);

  const jobId = crypto.randomUUID();

  const bridgeRes = await startBridgeDownloadJob(bridge, {
    url: targetUrl,
    dest,
    sha256: targetSha,
    jobId,
  });

  if (!bridgeRes.ok) {
    const errText = await bridgeErrorText(bridgeRes);
    return NextResponse.json(
      { error: `Bridge start failed: ${errText}` },
      { status: bridgeRes.status },
    );
  }

  return NextResponse.json({ jobId, dest, modelId, file: targetName });
}

/**
 * GET /api/desktop-runtime/hf-download
 * Lists all active download jobs from the bridge.
 */
export async function GET() {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  return proxyToBridge(bridge, "/hf-download-list");
}
