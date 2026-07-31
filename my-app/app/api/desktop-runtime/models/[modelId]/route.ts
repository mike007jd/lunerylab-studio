import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { findHfModelEntry, type HfModelEntry } from "@/lib/hf-model-catalog";
import {
  bridgeFetch,
  getBridgeDownloadStatus,
  requireDesktopBridge,
  type DesktopBridge,
} from "@/lib/server/desktop-bridge";
import { ApiError, jsonError } from "@/lib/server/errors";
import {
  findImportedModel,
  modelCachePath,
  removeImportedModel,
  type ImportedModelRecord,
} from "@/lib/server/imported-model-registry";
import {
  catalogModelFiles,
  removeManagedModelFiles,
} from "@/lib/server/local-model-files";
import { invalidateLocalModelInstallStatusCache } from "@/lib/server/local-model-inventory";
import { prisma } from "@/lib/server/prisma";
import { getLocalWorkspacePreferences, requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";

export const dynamic = "force-dynamic";

const MODEL_ID = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const ACTIVE_DOWNLOAD_STATUSES = new Set(["queued", "downloading"]);

interface LlamaStatus {
  running?: boolean;
  modelPath?: string | null;
  modelId?: string | null;
}

function modelSelectionIds(modelId: string): Set<string> {
  return new Set([modelId, `local:${modelId}`]);
}

function catalogModelPaths(entry: HfModelEntry): string[] {
  return catalogModelFiles(entry).flatMap(({ fileName }) => {
    const filePath = modelCachePath(entry.runtimeTarget, fileName);
    return [filePath, `${filePath}.part`];
  });
}

function importedModelPaths(record: ImportedModelRecord): string[] {
  if (record.source !== "huggingface-url") return [];
  return [record.modelPath, `${record.modelPath}.part`];
}

async function cancelActiveImport(bridge: DesktopBridge, record: ImportedModelRecord): Promise<void> {
  if (!record.jobId) return;
  const status = await getBridgeDownloadStatus(bridge, record.jobId);
  if (!status) {
    throw new ApiError({
      status: 503,
      code: "bridge_unreachable",
      message: "Could not verify the model download before removing it.",
      retryable: true,
    });
  }
  if (!ACTIVE_DOWNLOAD_STATUSES.has(String(status.status))) return;

  const response = await bridgeFetch(bridge, "/hf-download-cancel", {
    method: "POST",
    body: JSON.stringify({ jobId: record.jobId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new ApiError({
      status: 503,
      code: "download_cancel_failed",
      message: "Could not stop the model download. Try again.",
      retryable: true,
    });
  }
}

async function stopActiveLlama(
  bridge: DesktopBridge,
  modelId: string,
  modelPath: string | null,
): Promise<void> {
  const response = await bridgeFetch(bridge, "/llama-status", {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new ApiError({
      status: 503,
      code: "bridge_unreachable",
      message: "Could not verify whether the model is running.",
      retryable: true,
    });
  }

  const status = (await response.json().catch(() => null)) as LlamaStatus | null;
  if (!status?.running) return;

  const selectionIds = modelSelectionIds(modelId);
  const matchesId = typeof status.modelId === "string" && selectionIds.has(status.modelId);
  const matchesPath = Boolean(
    modelPath &&
      status.modelPath &&
      path.resolve(status.modelPath) === path.resolve(modelPath),
  );
  if (!matchesId && !matchesPath) return;

  const stopResponse = await bridgeFetch(bridge, "/llama-stop", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
  if (!stopResponse.ok) {
    throw new ApiError({
      status: 503,
      code: "runtime_stop_failed",
      message: "Could not stop the running model. Try again.",
      retryable: true,
    });
  }
}

async function clearDeletedModelDefaults(ownerId: string, modelId: string): Promise<string[]> {
  const settings = await getLocalWorkspacePreferences(ownerId);
  const ids = modelSelectionIds(modelId);
  const data: { defaultTextModel?: string; defaultImageModel?: string } = {};
  const cleared: string[] = [];

  if (ids.has(settings.defaultTextModel)) {
    data.defaultTextModel = "";
    cleared.push("text");
  }
  if (ids.has(settings.defaultImageModel)) {
    data.defaultImageModel = "";
    cleared.push("image");
  }
  if (cleared.length > 0) {
    await prisma.userSettings.update({ where: { userId: ownerId }, data });
  }
  return cleared;
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ modelId: string }> },
) {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  try {
    const owner = await requireLocalWorkspaceOwner();
    const rawModelId = (await params).modelId;
    const parsed = MODEL_ID.safeParse(rawModelId);
    if (!parsed.success) {
      throw new ApiError({
        status: 400,
        code: "invalid_model",
        message: "Invalid model id.",
        retryable: false,
      });
    }
    const modelId = parsed.data;
    const catalogEntry = findHfModelEntry(modelId);
    const imported = catalogEntry ? undefined : await findImportedModel(modelId);
    if (!catalogEntry && !imported) {
      throw new ApiError({
        status: 404,
        code: "model_not_found",
        message: "Model not found.",
        retryable: false,
      });
    }

    const modelPath = catalogEntry
      ? modelCachePath(catalogEntry.runtimeTarget, catalogEntry.fileName || catalogEntry.id)
      : imported?.modelPath ?? null;
    if (imported) await cancelActiveImport(bridge, imported);
    if (catalogEntry?.runtimeTarget === "llama-cpp" || imported?.runtimeTarget === "llama-cpp") {
      await stopActiveLlama(bridge, modelId, modelPath);
    }

    const paths = catalogEntry ? catalogModelPaths(catalogEntry) : importedModelPaths(imported!);
    const removedFiles = await removeManagedModelFiles(paths);
    if (imported) await removeImportedModel(modelId);
    const clearedDefaults = await clearDeletedModelDefaults(owner.id, modelId);
    invalidateLocalModelInstallStatusCache();

    return NextResponse.json({
      deleted: true,
      modelId,
      removedFiles,
      unregistered: Boolean(imported),
      preservedExternalFile: imported?.source === "local-path",
      clearedDefaults,
    });
  } catch (error) {
    return jsonError(error);
  }
}
