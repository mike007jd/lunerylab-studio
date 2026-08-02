import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { EXTERNAL_MODEL_DELETE_CONFIRMATION } from "@/lib/desktop-external-model-delete";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import { findHfModelEntry, type HfModelEntry } from "@/lib/hf-model-catalog";
import {
  BridgeDownloadJobsError,
  bridgeFetch,
  getBridgeDownloadJobs,
  requireDesktopBridge,
  type DesktopBridge,
} from "@/lib/server/desktop-bridge";
import { ApiError, jsonError } from "@/lib/server/errors";
import {
  findImportedModel,
  finishImportedExternalModelRollback,
  commitImportedExternalModelFile,
  modelCachePath,
  removeImportedModelIfUnchanged,
  rollbackImportedExternalModelFile,
  stageImportedExternalModelFile,
  upsertImportedModel,
  type ImportedModelRecord,
  type StagedExternalModelFile,
} from "@/lib/server/imported-model-registry";
import {
  catalogModelFiles,
  finalizeManagedModelFiles,
  markManagedModelFilesCommitted,
  rollbackManagedModelFiles,
  stageManagedModelFiles,
  ManagedModelCleanupPendingError,
  type StagedManagedModelFile,
} from "@/lib/server/local-model-files";
import { invalidateLocalModelInstallStatusCache } from "@/lib/server/local-model-inventory";
import { prisma } from "@/lib/server/prisma";
import { getLocalWorkspacePreferences, requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { withSharedMutationLease } from "@/lib/server/workspace-operation-gate";

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

async function canonicalModelPath(modelPath: string): Promise<string> {
  const resolved = path.resolve(modelPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    const parent = await fs.realpath(path.dirname(resolved)).catch(() => path.dirname(resolved));
    return path.join(parent, path.basename(resolved));
  }
}

async function settleActiveDownloadsForPaths(
  bridge: DesktopBridge,
  modelPaths: string[],
): Promise<void> {
  const destinations = new Set(await Promise.all(modelPaths.map(canonicalModelPath)));
  const matchingActiveJobs = async () => {
    let jobs: Awaited<ReturnType<typeof getBridgeDownloadJobs>>;
    try {
      jobs = await getBridgeDownloadJobs(bridge);
    } catch (error) {
      if (!(error instanceof BridgeDownloadJobsError)) throw error;
      throw new ApiError({
        status: error.code === "bridge_timeout" ? 504 : 503,
        code: error.code,
        message: "Could not inspect active model downloads.",
        retryable: true,
      });
    }
    const jobDestinations = await Promise.all(jobs.map((job) => canonicalModelPath(job.destination)));
    return jobs.filter((job, index) =>
      ACTIVE_DOWNLOAD_STATUSES.has(job.status)
      && destinations.has(jobDestinations[index]!)
    );
  };

  const active = await matchingActiveJobs();
  if (active.length === 0) return;
  await Promise.all(active.map(async (job) => {
    const response = await bridgeFetch(bridge, "/hf-download-cancel", {
      method: "POST",
      body: JSON.stringify({ jobId: job.jobId }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!response?.ok) {
      throw new ApiError({
        status: 503,
        code: "download_cancel_failed",
        message: "Could not stop the model download. Try again.",
        retryable: true,
      });
    }
  }));

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if ((await matchingActiveJobs()).length === 0) return;
  }
  throw new ApiError({
    status: 503,
    code: "download_cancel_timeout",
    message: "The model download did not stop in time.",
    retryable: true,
  });
}

interface ModelDeleteLeases {
  leaseId: string;
  downloadPaths: string[];
  llamaModelPath: string | null;
  sdModelPath: string | null;
}

async function acquireModelDeleteLeases(
  bridge: DesktopBridge,
  downloadPaths: string[],
  llamaModelPath: string | null,
  sdModelPath: string | null,
): Promise<ModelDeleteLeases> {
  const leases: ModelDeleteLeases = {
    leaseId: randomUUID(),
    downloadPaths: [],
    llamaModelPath: null,
    sdModelPath: null,
  };
  if (downloadPaths.length > 0) {
    const response = await bridgeFetch(bridge, "/hf-download-delete-lease-acquire", {
      method: "POST",
      body: JSON.stringify({ leaseId: leases.leaseId, destinations: downloadPaths }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!response) {
      throw new ApiError({
        status: 503,
        code: "bridge_unreachable",
        message: "Could not coordinate model deletion with the desktop runtime.",
        retryable: true,
      });
    }
    if (!response.ok) {
      throw new ApiError({
        status: 409,
        code: "model_delete_in_progress",
        message: "This model is already being changed. Try again.",
        retryable: true,
      });
    }
    leases.downloadPaths = downloadPaths;
  }
  if (llamaModelPath) {
    const response = await bridgeFetch(bridge, "/llama-delete-lease-acquire", {
      method: "POST",
      body: JSON.stringify({ leaseId: leases.leaseId, modelPath: llamaModelPath }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!response) {
      await releaseModelDeleteLeases(bridge, leases);
      throw new ApiError({
        status: 503,
        code: "bridge_unreachable",
        message: "Could not coordinate text-model deletion with the desktop runtime.",
        retryable: true,
      });
    }
    if (!response.ok) {
      await releaseModelDeleteLeases(bridge, leases);
      throw new ApiError({
        status: 409,
        code: "model_delete_in_progress",
        message: "This text model is already being changed. Try again.",
        retryable: true,
      });
    }
    leases.llamaModelPath = llamaModelPath;
  }
  if (sdModelPath) {
    const response = await bridgeFetch(bridge, "/sd-delete-lease-acquire", {
      method: "POST",
      body: JSON.stringify({ leaseId: leases.leaseId, modelPath: sdModelPath }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!response) {
      await releaseModelDeleteLeases(bridge, leases);
      throw new ApiError({
        status: 503,
        code: "bridge_unreachable",
        message: "Could not coordinate image-model deletion with the desktop runtime.",
        retryable: true,
      });
    }
    if (!response.ok) {
      await releaseModelDeleteLeases(bridge, leases);
      throw new ApiError({
        status: 409,
        code: "model_delete_in_progress",
        message: "This image model is already being changed. Try again.",
        retryable: true,
      });
    }
    leases.sdModelPath = sdModelPath;
  }
  return leases;
}

async function releaseModelDeleteLeases(
  bridge: DesktopBridge,
  leases: ModelDeleteLeases,
): Promise<void> {
  const releases: Promise<unknown>[] = [];
  if (leases.downloadPaths.length > 0) {
    releases.push(bridgeFetch(bridge, "/hf-download-delete-lease-release", {
      method: "POST",
      body: JSON.stringify({
        leaseId: leases.leaseId,
        destinations: leases.downloadPaths,
      }),
      signal: AbortSignal.timeout(5_000),
    }));
  }
  if (leases.llamaModelPath) {
    releases.push(bridgeFetch(bridge, "/llama-delete-lease-release", {
      method: "POST",
      body: JSON.stringify({ leaseId: leases.leaseId, modelPath: leases.llamaModelPath }),
      signal: AbortSignal.timeout(5_000),
    }));
  }
  if (leases.sdModelPath) {
    releases.push(bridgeFetch(bridge, "/sd-delete-lease-release", {
      method: "POST",
      body: JSON.stringify({ leaseId: leases.leaseId, modelPath: leases.sdModelPath }),
      signal: AbortSignal.timeout(5_000),
    }));
  }
  await Promise.allSettled(releases);
}

async function renewModelDeleteLeases(
  bridge: DesktopBridge,
  leases: ModelDeleteLeases,
): Promise<void> {
  const renewals: Array<{ endpoint: string; body: string }> = [];
  if (leases.downloadPaths.length > 0) {
    renewals.push({
      endpoint: "/hf-download-delete-lease-acquire",
      body: JSON.stringify({
        leaseId: leases.leaseId,
        destinations: leases.downloadPaths,
      }),
    });
  }
  if (leases.llamaModelPath) {
    renewals.push({
      endpoint: "/llama-delete-lease-acquire",
      body: JSON.stringify({ leaseId: leases.leaseId, modelPath: leases.llamaModelPath }),
    });
  }
  if (leases.sdModelPath) {
    renewals.push({
      endpoint: "/sd-delete-lease-acquire",
      body: JSON.stringify({ leaseId: leases.leaseId, modelPath: leases.sdModelPath }),
    });
  }
  for (const renewal of renewals) {
    const response = await bridgeFetch(bridge, renewal.endpoint, {
      method: "POST",
      body: renewal.body,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!response?.ok) {
      throw new ApiError({
        status: 503,
        code: "model_delete_lease_expired",
        message: "Model deletion coordination expired. Try again.",
        retryable: true,
      });
    }
  }
}

const MODEL_DELETE_LEASE_HEARTBEAT_MS = 15_000;

interface ModelDeleteLeaseHeartbeat {
  assertHealthy(): Promise<void>;
  stop(): Promise<unknown | null>;
}

function startModelDeleteLeaseHeartbeat(
  bridge: DesktopBridge,
  leases: ModelDeleteLeases,
): ModelDeleteLeaseHeartbeat {
  let stopped = false;
  let failure: unknown | null = null;
  let inFlight: Promise<void> | null = null;
  const tick = () => {
    if (stopped || failure || inFlight) return;
    inFlight = renewModelDeleteLeases(bridge, leases)
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = setInterval(tick, MODEL_DELETE_LEASE_HEARTBEAT_MS);
  timer.unref?.();
  return {
    async assertHealthy() {
      await inFlight;
      if (failure) throw failure;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      return failure;
    },
  };
}

async function stopActiveLlama(
  bridge: DesktopBridge,
  modelId: string,
  modelPath: string | null,
): Promise<void> {
  const response = await bridgeFetch(bridge, "/llama-status", {
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) {
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
  }).catch(() => null);
  if (!stopResponse?.ok) {
    throw new ApiError({
      status: 503,
      code: "runtime_stop_failed",
      message: "Could not stop the running model. Try again.",
      retryable: true,
    });
  }
  const settledResponse = await bridgeFetch(bridge, "/llama-status", {
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!settledResponse?.ok) {
    throw new ApiError({
      status: 503,
      code: "bridge_unreachable",
      message: "Could not verify that the running model stopped.",
      retryable: true,
    });
  }
  const settled = (await settledResponse.json().catch(() => null)) as LlamaStatus | null;
  const stillMatchesId = typeof settled?.modelId === "string" && selectionIds.has(settled.modelId);
  const stillMatchesPath = Boolean(
    modelPath
      && settled?.modelPath
      && path.resolve(settled.modelPath) === path.resolve(modelPath),
  );
  if (settled?.running && (stillMatchesId || stillMatchesPath)) {
    throw new ApiError({
      status: 503,
      code: "runtime_stop_failed",
      message: "The running model did not stop in time. Try again.",
      retryable: true,
    });
  }
}

async function stopActiveSd(bridge: DesktopBridge, modelPath: string | null): Promise<void> {
  const response = await bridgeFetch(bridge, "/sd-status", {
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) {
    throw new ApiError({
      status: 503,
      code: "bridge_unreachable",
      message: "Could not verify whether the image model is running.",
      retryable: true,
    });
  }
  const status = (await response.json().catch(() => null)) as SdStatus | null;
  if (!status?.running) return;
  const [expectedPath, activePath] = await Promise.all([
    modelPath ? fs.realpath(modelPath).catch(() => path.resolve(modelPath)) : null,
    status.modelPath
      ? fs.realpath(status.modelPath).catch(() => path.resolve(status.modelPath!))
      : null,
  ]);
  if (
    !expectedPath
    || !activePath
    || activePath !== expectedPath
  ) return;

  const stopResponse = await bridgeFetch(bridge, "/sd-stop", {
    method: "POST",
    body: JSON.stringify({ modelPath }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!stopResponse?.ok) {
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
    return await withSharedMutationLease(async () => {
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
    if (bridgeResult instanceof NextResponse) {
      throw new ApiError({
        status: 503,
        code: "bridge_unreachable",
        message: "Could not coordinate model deletion with the desktop runtime.",
        retryable: true,
      });
    }
    const bridge = bridgeResult;
    const warnings: string[] = [];

    const modelPath = catalogEntry
      ? modelCachePath(catalogEntry.runtimeTarget, catalogEntry.fileName || catalogEntry.id)
      : imported?.modelPath ?? null;
    const downloadablePaths = catalogEntry
      ? catalogModelFiles(catalogEntry).map(({ fileName }) =>
        modelCachePath(catalogEntry.runtimeTarget, fileName))
      : imported?.source === "huggingface-url"
        ? [imported.modelPath]
        : [];
    const isSdModel = catalogEntry?.runtimeTarget === "sd-cpp"
      || imported?.runtimeTarget === "sd-cpp";
    const isLlamaModel = catalogEntry?.runtimeTarget === "llama-cpp"
      || imported?.runtimeTarget === "llama-cpp";
    let leases: ModelDeleteLeases | null = null;
    let heartbeat: ModelDeleteLeaseHeartbeat | null = null;
    try {
    leases = await acquireModelDeleteLeases(
      bridge,
      downloadablePaths,
      isLlamaModel ? modelPath : null,
      isSdModel ? modelPath : null,
    );
    if (downloadablePaths.length > 0) {
      await settleActiveDownloadsForPaths(bridge, downloadablePaths);
    }
    if (isLlamaModel) {
      await stopActiveLlama(bridge, modelId, modelPath);
    }
    if (isSdModel) {
      await stopActiveSd(bridge, modelPath);
    }

    // Cancel/stop polling can consume most of a lease lifetime. Refresh every
    // acquired lease with the same leaseId immediately before any file stage
    // or metadata commit; an unavailable/expired renewal is a hard stop.
    await renewModelDeleteLeases(bridge, leases);
    heartbeat = startModelDeleteLeaseHeartbeat(bridge, leases);

    const paths = catalogEntry ? catalogModelPaths(catalogEntry) : importedModelPaths(imported!);
    let stagedExternal: StagedExternalModelFile | null = null;
    let stagedManaged: StagedManagedModelFile[] = [];
    let clearedDefaults: ClearedModelDefaults | null = null;
    let registryRemoved = false;
    let removedFiles = 0;
    try {
      if (imported?.source === "local-path" && deleteExternalFile) {
        stagedExternal = await stageImportedExternalModelFile(imported);
        if (stagedExternal.preservedChangedFile) {
          warnings.push("external_file_changed_preserved");
        }
      }
      stagedManaged = await stageManagedModelFiles(paths);
      await heartbeat.assertHealthy();
      clearedDefaults = await clearDeletedModelDefaults(owner.id, modelId);
      await heartbeat.assertHealthy();
      if (imported) {
        await removeImportedModelIfUnchanged(imported);
        registryRemoved = true;
      }
      await markManagedModelFilesCommitted(stagedManaged);
      await heartbeat.assertHealthy();
    } catch (error) {
      try {
        await rollbackManagedModelFiles(stagedManaged);
        if (stagedExternal && imported) {
          const restored = await rollbackImportedExternalModelFile(stagedExternal, imported);
          await upsertImportedModel(restored);
          await finishImportedExternalModelRollback(stagedExternal);
        } else if (registryRemoved && imported) {
          await upsertImportedModel(imported);
        }
        if (clearedDefaults) {
          await restoreDeletedModelDefaults(owner.id, clearedDefaults);
        }
      } catch {
        throw new ApiError({
          status: 503,
          code: "model_delete_rollback_failed",
          message: "Model deletion could not be completed or fully rolled back. Restart Studio and try again.",
          retryable: true,
        });
      }
      throw error;
    }

    let cleanupPending = false;
    try {
      removedFiles = await finalizeManagedModelFiles(stagedManaged);
    } catch (error) {
      cleanupPending = true;
      warnings.push("managed_file_cleanup_pending");
      if (error instanceof ManagedModelCleanupPendingError) {
        removedFiles = error.removedFiles;
      }
    }
    if (stagedExternal) {
      try {
        removedFiles += await commitImportedExternalModelFile(stagedExternal);
      } catch {
        cleanupPending = true;
        warnings.push("external_file_cleanup_pending");
      }
    }
    const heartbeatFailure = await heartbeat.stop();
    heartbeat = null;
    if (heartbeatFailure) {
      cleanupPending = true;
      warnings.push("model_delete_lease_expired_after_commit");
    }
    invalidateLocalModelInstallStatusCache();

    return NextResponse.json({
      deleted: true,
      modelId,
      removedFiles,
      unregistered: Boolean(imported),
      preservedExternalFile: imported?.source === "local-path"
        && (!deleteExternalFile || Boolean(stagedExternal?.preservedChangedFile)),
      clearedDefaults: clearedDefaults?.cleared ?? [],
      cleanupPending,
      warnings,
    });
    } finally {
      if (heartbeat) await heartbeat.stop();
      if (leases) await releaseModelDeleteLeases(bridge, leases);
    }
    });
  } catch (error) {
    return jsonError(error);
  }
}
