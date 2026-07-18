import { promises as fs, constants as fsConstants } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { findHfModelEntry } from "@/lib/hf-model-catalog";
import { proxyToBridge, requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { findImportedModel, modelCachePath } from "@/lib/server/imported-model-registry";
import { jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";

export const dynamic = "force-dynamic";

const llamaBodySchema = z.object({
  modelId: z.string().optional(),
  action: z.enum(["start", "stop"]).optional(),
});

/** Resolve the on-disk GGUF path the hf-download route writes to. */
function modelDestPath(modelId: string): string | null {
  const entry = findHfModelEntry(modelId);
  if (!entry) return null;
  const fileName = entry.fileName || entry.id;
  return modelCachePath(entry.runtimeTarget, fileName);
}

type ModelFileCheck = { ok: true } | { ok: false; reason: string };

/**
 * Confirm the GGUF is present AND readable, returning a human-actionable reason
 * on failure. The previous boolean check collapsed "deleted", "permission
 * denied" and "path is a directory" into one opaque 404, leaving the user with
 * no way to tell what went wrong or how to fix it.
 */
async function checkModelFile(filePath: string): Promise<ModelFileCheck> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return { ok: false, reason: "The model path exists but is not a file." };
    }
    await fs.access(filePath, fsConstants.R_OK);
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return {
        ok: false,
        reason: "The model file is missing — it may have been moved or deleted. Re-download or re-import it.",
      };
    }
    if (code === "EACCES" || code === "EPERM") {
      return {
        ok: false,
        reason: "Permission denied reading the model file. Check its file permissions and try again.",
      };
    }
    return { ok: false, reason: "The model file could not be read from disk." };
  }
}

/** POST { modelId } → start (or switch) the embedded engine on that model. */
export async function POST(request: NextRequest) {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  let body: z.infer<typeof llamaBodySchema>;
  try {
    body = await parseJsonBody(request, llamaBodySchema);
  } catch (error) {
    return jsonError(error);
  }

  if (body.action === "stop") {
    return proxyToBridge(bridge, "/llama-stop", { method: "POST" });
  }

  const { modelId } = body;
  if (!modelId) {
    return NextResponse.json({ error: "modelId is required" }, { status: 400 });
  }
  const entry = findHfModelEntry(modelId);
  let modelPath: string | null = null;

  if (entry) {
    if (entry.capability !== "planner-llm" || entry.runtimeTarget !== "llama-cpp") {
      return NextResponse.json(
        { error: `Model ${modelId} is not a llama.cpp text model` },
        { status: 400 },
      );
    }
    modelPath = modelDestPath(modelId);
  } else {
    const imported = await findImportedModel(modelId);
    if (!imported) {
      return NextResponse.json({ error: `Unknown model id: ${modelId}` }, { status: 404 });
    }
    if (imported.capability !== "planner-llm" || imported.runtimeTarget !== "llama-cpp" || imported.format !== "gguf") {
      return NextResponse.json(
        { error: `Model ${modelId} is not a llama.cpp text model` },
        { status: 400 },
      );
    }
    modelPath = imported.modelPath;
  }

  if (!modelPath) {
    return NextResponse.json({ error: "Model file is not available on disk" }, { status: 404 });
  }
  const fileCheck = await checkModelFile(modelPath);
  if (!fileCheck.ok) {
    return NextResponse.json({ error: fileCheck.reason }, { status: 404 });
  }

  return proxyToBridge(bridge, "/llama-start", {
    method: "POST",
    body: JSON.stringify({ modelPath }),
    timeoutMs: 45000,
  });
}

/** GET → embedded engine status. */
export async function GET() {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  return proxyToBridge(bridge, "/llama-status");
}
