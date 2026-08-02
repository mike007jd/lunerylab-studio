import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  bridgeErrorText,
  probeBridgeDownloadJob,
  requireDesktopBridge,
  startBridgeDownloadJob,
} from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { ApiError, jsonError } from "@/lib/server/errors";
import { resolveHuggingFaceModelFileUrl } from "@/lib/server/hf-import-url";
import {
  findImportedModel,
  importedModelDownloadDest,
  importedModelId,
  normalizeImportableRuntimeTarget,
  resolveLocalModelPath,
  QueuedImportedModelStartUncertainError,
  upsertImportedModel,
  validateImportedRuntimeFormat,
  withQueuedImportedModelReservation,
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

function queuedImportResponse(record: NonNullable<Awaited<ReturnType<typeof findImportedModel>>>, extra: {
  recovered?: boolean;
} = {}) {
  return NextResponse.json({
    imported: true,
    queued: true,
    reused: true,
    ...extra,
    jobId: record.jobId,
    fileName: record.fileName,
    runtimeTarget: record.runtimeTarget,
    dest: record.modelPath,
    model: record,
  });
}

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

class BridgeStartError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
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
      fileIdentity: resolved.fileIdentity,
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
    const existingProbe = await probeBridgeDownloadJob(bridge, existing.jobId);
    if (existingProbe.outcome === "observed" && ACTIVE_IMPORT_STATUSES.has(existingProbe.status)) {
      return queuedImportResponse(existing);
    }
    if (existingProbe.outcome === "ambiguous") {
      return NextResponse.json(
        {
          error: "Existing model import status is unknown; queued ownership was retained.",
          code: existingProbe.code,
          partialState: true,
          queued: true,
          retryable: true,
          jobId: existing.jobId,
        },
        { status: existingProbe.code === "bridge_timeout" ? 504 : 503 },
      );
    }
    if (existingProbe.outcome === "not_found") {
      // An earlier start may have been accepted even though both its response
      // and the immediate status probe were lost. Re-submit the exact durable
      // request identity under the original jobId. Native start is idempotent
      // for same-ID/same-payload and adopts the existing reservation instead
      // of creating a second job.
      if (
        existing.source !== "huggingface-url"
        || !existing.url
        || !existing.sha256
        || existing.modelPath !== dest
      ) {
        return NextResponse.json(
          {
            error: "Existing model import ownership is incomplete and cannot be retried safely.",
            code: "bridge_start_unknown",
            partialState: true,
            queued: true,
            retryable: false,
            jobId: existing.jobId,
          },
          { status: 409 },
        );
      }
      try {
        const retry = await startBridgeDownloadJob(bridge, {
          url: existing.url,
          dest: existing.modelPath,
          sha256: existing.sha256,
          jobId: existing.jobId,
        });
        if (!retry.ok) {
          const message = await bridgeErrorText(retry).catch(() => `HTTP ${retry.status}`);
          return NextResponse.json(
            {
              error: `Bridge start failed: ${message}`,
              code: "bridge_start_rejected",
              queued: true,
              retryable: false,
              jobId: existing.jobId,
            },
            { status: retry.status },
          );
        }
        return queuedImportResponse(existing, { recovered: true });
      } catch {
        const observed = await probeBridgeDownloadJob(bridge, existing.jobId);
        if (observed.outcome === "observed") {
          return queuedImportResponse(existing, { recovered: true });
        }
        return NextResponse.json(
          {
            error: "Existing model import status is unknown; queued ownership was retained.",
            code: "bridge_start_unknown",
            partialState: true,
            queued: true,
            retryable: true,
            jobId: existing.jobId,
          },
          { status: 503 },
        );
      }
    }
  }

  const jobId = crypto.randomUUID();
  const sha256 = await fetchHuggingFaceSha256(resolved.url);
  if (typeof sha256 !== "string") {
    return NextResponse.json({ error: sha256.error }, { status: 400 });
  }

  // Persist queued ownership before invoking the desktop bridge so a crash or
  // launch failure cannot leave an untracked download. Compensate on start
  // failure so no false importing/queued record remains.
  const queuedRecord = {
    id: modelId,
    label: body.label?.trim() || resolved.fileName,
    source: "huggingface-url" as const,
    runtimeTarget,
    capability: runnable.capability,
    format: runnable.format,
    fileName: resolved.fileName,
    modelPath: dest,
    sizeBytes: 0,
    sha256,
    status: "queued" as const,
    createdAt: new Date().toISOString(),
    url: resolved.url,
    jobId,
  };

  let record;
  try {
    const reservation = await withQueuedImportedModelReservation({
      record: queuedRecord,
      expectedPrevious: existing,
      start: async () => {
        let bridgeRes: Response;
        try {
          bridgeRes = await startBridgeDownloadJob(bridge, {
            url: resolved.url,
            dest,
            sha256,
            jobId,
          });
        } catch (error) {
          // The local bridge can accept/start the job and then lose the HTTP
          // response. Probe by jobId before deciding whether queued ownership
          // is safe to remove.
          const observed = await probeBridgeDownloadJob(bridge, jobId);
          if (observed.outcome === "observed") {
            return new Response(null, { status: 202 });
          }
          // A single immediate "unknown" does not prove rejection: the native
          // worker can reserve/spawn after the status probe. Any transport-loss
          // outcome therefore retains queued ownership. Only an explicit HTTP
          // rejection from the start request is safe to compensate.
          throw new QueuedImportedModelStartUncertainError(
            "Desktop bridge start outcome is unknown; queued ownership was retained.",
            { cause: error },
          );
        }
        if (!bridgeRes.ok) {
          const message = await bridgeErrorText(bridgeRes).catch(
            () => `HTTP ${bridgeRes.status}`,
          );
          throw new BridgeStartError(message, bridgeRes.status);
        }
        return bridgeRes;
      },
    });
    record = reservation.record;
  } catch (error) {
    if (error instanceof BridgeStartError) {
      return NextResponse.json(
        { error: `Bridge start failed: ${error.message}` },
        { status: error.status },
      );
    }
    if (error instanceof ApiError && error.code === "imported_model_registry_compensation_failed") {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          partialState: true,
          jobId,
        },
        { status: error.status },
      );
    }
    if (error instanceof QueuedImportedModelStartUncertainError) {
      return NextResponse.json(
        {
          error: error.message,
          code: "bridge_start_unknown",
          partialState: true,
          queued: true,
          retryable: true,
          jobId,
        },
        { status: 503 },
      );
    }
    return jsonError(error);
  }

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
