import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { EXTERNAL_MODEL_DELETE_CONFIRMATION } from "@/lib/desktop-external-model-delete";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
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
  upsertImportedModel,
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

interface SdStatus {
  running?: boolean;
  modelPath?: string | null;
}

interface SdStopResult {
  stopped?: boolean;
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

interface StagedExternalModelFile {
  originalPath: string;
  stagedPath: string;
  hadFile: boolean;
}

function externalIdentityMatches(
  record: ImportedModelRecord,
  stat: import("node:fs").BigIntStats,
): boolean {
  const identity = record.fileIdentity;
  if (!identity) return false;
  return stat.isFile()
    && stat.dev.toString() === identity.device
    && stat.ino.toString() === identity.inode
    && stat.size.toString() === identity.sizeBytes
    && stat.mtimeNs.toString() === identity.modifiedAtNs;
}

async function stageImportedExternalFile(
  record: ImportedModelRecord,
): Promise<StagedExternalModelFile> {
  let stagedPath = "";
  try {
    const handle = await fs.open(record.modelPath, "r");
    try {
      const opened = await handle.stat({ bigint: true });
      const current = await fs.lstat(record.modelPath, { bigint: true });
      if (!externalIdentityMatches(record, opened) || !externalIdentityMatches(record, current)) {
        throw new ApiError({
          status: 409,
          code: "external_model_file_changed",
          message: "The imported model path now points to a different file. Import it again before deleting it.",
          retryable: false,
        });
      }
    } finally {
      await handle.close();
    }
    stagedPath = path.join(
      path.dirname(record.modelPath),
      `.${path.basename(record.modelPath)}.lunery-delete-${randomUUID()}`,
    );
    await fs.rename(record.modelPath, stagedPath);
    try {
      const staged = await fs.lstat(stagedPath, { bigint: true });
      if (!externalIdentityMatches(record, staged)) {
        throw new ApiError({
          status: 409,
          code: "external_model_file_changed",
          message: "The imported model path changed while it was being deleted. Import it again before retrying.",
          retryable: false,
        });
      }
    } catch (error) {
      try {
        await fs.rename(stagedPath, record.modelPath);
      } catch {
        throw new ApiError({
          status: 503,
          code: "external_model_delete_rollback_failed",
          message: "The imported model file could not be restored after its identity changed. Restart Studio and try again.",
          retryable: true,
        });
      }
      throw error;
    }
    return { originalPath: record.modelPath, stagedPath, hadFile: true };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { originalPath: record.modelPath, stagedPath: "", hadFile: false };
    }
    throw new ApiError({
      status: 503,
      code: "external_model_file_delete_failed",
      message: "Could not stage the imported model file for deletion. Please try again.",
      retryable: true,
    });
  }
}

async function rollbackImportedExternalFile(stage: StagedExternalModelFile): Promise<void> {
  if (!stage.hadFile) return;
  await fs.rename(stage.stagedPath, stage.originalPath);
}

async function commitImportedExternalFile(stage: StagedExternalModelFile): Promise<number> {
  if (!stage.hadFile) return 0;
  await fs.unlink(stage.stagedPath);
  return 1;
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

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = await getBridgeDownloadStatus(bridge, record.jobId);
    if (next && !ACTIVE_DOWNLOAD_STATUSES.has(String(next.status))) return;
  }
  throw new ApiError({
    status: 503,
    code: "download_cancel_timeout",
    message: "The model download did not stop in time.",
    retryable: true,
  });
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

async function stopActiveSd(bridge: DesktopBridge, modelPath: string | null): Promise<void> {
  const response = await bridgeFetch(bridge, "/sd-status", {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new ApiError({
      status: 503,
      code: "bridge_unreachable",
      message: "Could not verify whether the image model is running.",
      retryable: true,
    });
  }
  const status = (await response.json().catch(() => null)) as SdStatus | null;
  if (!status?.running) return;
  if (
    !modelPath
    || !status.modelPath
    || path.resolve(status.modelPath) !== path.resolve(modelPath)
  ) return;

  const stopResponse = await bridgeFetch(bridge, "/sd-stop", {
    method: "POST",
    body: JSON.stringify({ modelPath: status.modelPath }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!stopResponse.ok) {
    throw new ApiError({
      status: 503,
      code: "runtime_stop_failed",
      message: "Could not stop the running image model. Try again.",
      retryable: true,
    });
  }
  const stopResult = (await stopResponse.json().catch(() => null)) as SdStopResult | null;
  if (!stopResult?.stopped) {
    throw new ApiError({
      status: 503,
      code: "runtime_stop_failed",
      message: "The running image model did not stop in time. Try again.",
      retryable: true,
    });
  }
}

interface ClearedModelDefaults {
  cleared: string[];
  previous: { defaultTextModel: string; defaultImageModel: string };
}

async function clearDeletedModelDefaults(
  ownerId: string,
  modelId: string,
): Promise<ClearedModelDefaults> {
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
  return {
    cleared,
    previous: {
      defaultTextModel: settings.defaultTextModel,
      defaultImageModel: settings.defaultImageModel,
    },
  };
}

async function restoreDeletedModelDefaults(
  ownerId: string,
  defaults: ClearedModelDefaults,
): Promise<void> {
  const data: { defaultTextModel?: string; defaultImageModel?: string } = {};
  if (defaults.cleared.includes("text")) data.defaultTextModel = defaults.previous.defaultTextModel;
  if (defaults.cleared.includes("image")) data.defaultImageModel = defaults.previous.defaultImageModel;
  if (Object.keys(data).length > 0) {
    await prisma.userSettings.update({ where: { userId: ownerId }, data });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ modelId: string }> },
) {
  try {
    if (!isDesktopRuntime()) {
      return NextResponse.json(
        { error: "Desktop runtime bridge is not available" },
        { status: 404 },
      );
    }
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

    const requestBody = await request.json().catch(() => null) as {
      deleteExternalFile?: unknown;
      confirmation?: unknown;
    } | null;
    const deleteExternalFile = imported?.source === "local-path"
      && requestBody?.deleteExternalFile === true
      && requestBody.confirmation === EXTERNAL_MODEL_DELETE_CONFIRMATION;

    const bridgeResult = requireDesktopBridge();
    const bridge = bridgeResult instanceof NextResponse ? null : bridgeResult;
    const warnings: string[] = [];

    const modelPath = catalogEntry
      ? modelCachePath(catalogEntry.runtimeTarget, catalogEntry.fileName || catalogEntry.id)
      : imported?.modelPath ?? null;
    if (
      imported?.jobId
      && ACTIVE_DOWNLOAD_STATUSES.has(String(imported.status))
    ) {
      if (!bridge) {
        throw new ApiError({
          status: 503,
          code: "bridge_unreachable",
          message: "Could not verify the model download before removing it.",
          retryable: true,
        });
      }
      // Active Hugging Face work must settle before managed files are removed.
      await cancelActiveImport(bridge, imported);
    }
    if (catalogEntry?.runtimeTarget === "llama-cpp" || imported?.runtimeTarget === "llama-cpp") {
      if (bridge) {
        try {
          await stopActiveLlama(bridge, modelId, modelPath);
        } catch {
          warnings.push("runtime_not_stopped");
        }
      } else {
        warnings.push("runtime_not_stopped");
      }
    }
    if (catalogEntry?.runtimeTarget === "sd-cpp" || imported?.runtimeTarget === "sd-cpp") {
      if (bridge) {
        try {
          // A positively identified active run must settle before its file is removed.
          await stopActiveSd(bridge, modelPath);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "bridge_unreachable") throw error;
          warnings.push("runtime_not_stopped");
        }
      } else {
        // Bridge availability is not permission to delete. A missing probe can
        // only reduce cleanup confidence; it must not disable the user action.
        warnings.push("runtime_not_stopped");
      }
    }

    const paths = catalogEntry ? catalogModelPaths(catalogEntry) : importedModelPaths(imported!);
    let stagedExternal: StagedExternalModelFile | null = null;
    let clearedDefaults: ClearedModelDefaults | null = null;
    let removedFiles = 0;
    try {
      if (imported?.source === "local-path" && deleteExternalFile) {
        stagedExternal = await stageImportedExternalFile(imported);
      }
      removedFiles = await removeManagedModelFiles(paths);
      if (imported) await removeImportedModel(modelId);
      clearedDefaults = await clearDeletedModelDefaults(owner.id, modelId);
      if (stagedExternal) removedFiles += await commitImportedExternalFile(stagedExternal);
    } catch (error) {
      if (stagedExternal && imported) {
        const rollback = await Promise.allSettled([
          rollbackImportedExternalFile(stagedExternal),
          upsertImportedModel(imported),
          ...(clearedDefaults ? [restoreDeletedModelDefaults(owner.id, clearedDefaults)] : []),
        ]);
        if (rollback.some((result) => result.status === "rejected")) {
          throw new ApiError({
            status: 503,
            code: "external_model_delete_rollback_failed",
            message: "Model deletion could not be completed or fully rolled back. Restart Studio and try again.",
            retryable: true,
          });
        }
      }
      throw error;
    }
    invalidateLocalModelInstallStatusCache();

    return NextResponse.json({
      deleted: true,
      modelId,
      removedFiles,
      unregistered: Boolean(imported),
      preservedExternalFile: imported?.source === "local-path" && !deleteExternalFile,
      clearedDefaults: clearedDefaults?.cleared ?? [],
      warnings,
    });
  } catch (error) {
    return jsonError(error);
  }
}
