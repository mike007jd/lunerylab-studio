import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  bridgeErrorText,
  getBridgeDownloadStatus,
  requireDesktopBridge,
  startBridgeDownloadJob,
} from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";
import { resolveHuggingFaceModelFileUrl } from "@/lib/server/hf-import-url";
import {
  findImportedModel,
  importedModelDownloadDest,
  importedModelId,
  normalizeImportableRuntimeTarget,
  resolveLocalModelPath,
  upsertImportedModel,
  validateImportedRuntimeFormat,
} from "@/lib/server/imported-model-registry";

export const dynamic = "force-dynamic";

const importModelBodySchema = z.object({
  source: z.enum(["local-path", "huggingface-url"]).optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  label: z.string().optional(),
  runtimeTarget: z.string().optional(),
});

const ACTIVE_IMPORT_STATUSES = new Set(["queued", "downloading"]);

// Required SHA-256 preflight for integrity verification. Hugging Face returns
// the SHA-256 of an LFS/Xet artifact in `x-linked-etag` on the /resolve HEAD
// response before the CDN redirect. Plain HTML pages and git blob SHA-1 etags
// are rejected so a browser page can never be imported as a model.
async function fetchHuggingFaceSha256(url: string): Promise<string | { error: string }> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("text/html")) {
      return { error: "The Hugging Face URL points to a page, not a model artifact." };
    }
    const candidate = (res.headers.get("x-linked-etag") || "")
      .replace(/^W\//, "")
      .replace(/"/g, "")
      .trim()
      .toLowerCase();
    if (/^[0-9a-f]{64}$/.test(candidate)) return candidate;
    return { error: "Could not verify the Hugging Face model artifact checksum." };
  } catch {
    return { error: "Could not verify the Hugging Face model artifact." };
  }
}

export async function POST(request: NextRequest) {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Browser file upload is disabled for model-sized files. Register an absolute local path instead." },
      { status: 400 },
    );
  }

  let body: z.infer<typeof importModelBodySchema>;
  try {
    body = await parseJsonBody(request, importModelBodySchema);
  } catch (error) {
    return jsonError(error);
  }

  const runtimeTarget = normalizeImportableRuntimeTarget(body.runtimeTarget);
  if (!runtimeTarget) {
    return NextResponse.json({ error: "runtimeTarget is required" }, { status: 400 });
  }

  if (body.source === "local-path") {
    const resolved = await resolveLocalModelPath(body.path ?? "");
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }
    const runnable = validateImportedRuntimeFormat(runtimeTarget, resolved.fileName);
    if ("error" in runnable) {
      return NextResponse.json({ error: runnable.error }, { status: 400 });
    }
    const record = await upsertImportedModel({
      id: importedModelId(runtimeTarget, resolved.fileName, resolved.modelPath),
      label: body.label?.trim() || resolved.fileName,
      source: "local-path",
      runtimeTarget,
      capability: runnable.capability,
      format: runnable.format,
      fileName: resolved.fileName,
      modelPath: resolved.modelPath,
      sizeBytes: resolved.sizeBytes,
      sha256: null,
      status: "ready",
      createdAt: new Date().toISOString(),
    });
    return NextResponse.json({ imported: true, model: record });
  }

  if (body.source !== "huggingface-url" || !body.url) {
    return NextResponse.json({ error: "Hugging Face URL or local path is required" }, { status: 400 });
  }

  const resolved = resolveHuggingFaceModelFileUrl(body.url);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const runnable = validateImportedRuntimeFormat(runtimeTarget, resolved.fileName);
  if ("error" in runnable) {
    return NextResponse.json({ error: runnable.error }, { status: 400 });
  }

  const modelId = importedModelId(runtimeTarget, resolved.fileName, resolved.url);
  const dest = importedModelDownloadDest(runtimeTarget, modelId, resolved.fileName);
  const existing = await findImportedModel(modelId);
  if (existing?.jobId) {
    const existingStatus = await getBridgeDownloadStatus(bridge, existing.jobId);
    if (typeof existingStatus?.status === "string" && ACTIVE_IMPORT_STATUSES.has(existingStatus.status)) {
      return NextResponse.json({
        imported: true,
        queued: true,
        reused: true,
        jobId: existing.jobId,
        fileName: existing.fileName,
        runtimeTarget: existing.runtimeTarget,
        dest: existing.modelPath,
        model: existing,
      });
    }
  }

  const jobId = crypto.randomUUID();
  const sha256 = await fetchHuggingFaceSha256(resolved.url);
  if (typeof sha256 !== "string") {
    return NextResponse.json({ error: sha256.error }, { status: 400 });
  }
  const bridgeRes = await startBridgeDownloadJob(bridge, {
    url: resolved.url,
    dest,
    sha256,
    jobId,
  });

  if (!bridgeRes.ok) {
    return NextResponse.json(
      { error: `Bridge start failed: ${await bridgeErrorText(bridgeRes)}` },
      { status: bridgeRes.status },
    );
  }

  const record = await upsertImportedModel({
    id: modelId,
    label: body.label?.trim() || resolved.fileName,
    source: "huggingface-url",
    runtimeTarget,
    capability: runnable.capability,
    format: runnable.format,
    fileName: resolved.fileName,
    modelPath: dest,
    sizeBytes: 0,
    sha256,
    status: "queued",
    createdAt: new Date().toISOString(),
    url: resolved.url,
    jobId,
  });

  return NextResponse.json({
    imported: true,
    queued: true,
    jobId,
    fileName: resolved.fileName,
    runtimeTarget,
    dest,
    model: record,
  });
}
