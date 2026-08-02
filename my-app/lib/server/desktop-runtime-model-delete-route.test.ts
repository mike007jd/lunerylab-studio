import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { EXTERNAL_MODEL_DELETE_CONFIRMATION } from "@/lib/desktop-external-model-delete";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  isDesktopRuntime: vi.fn(),
  findHfModelEntry: vi.fn(),
  bridgeFetch: vi.fn(),
  getBridgeDownloadJobs: vi.fn(),
  requireDesktopBridge: vi.fn(),
  findImportedModel: vi.fn(),
  modelCachePath: vi.fn(),
  removeImportedModel: vi.fn(),
  upsertImportedModel: vi.fn(),
  stageImportedExternalModelFile: vi.fn(),
  rollbackImportedExternalModelFile: vi.fn(),
  finishImportedExternalModelRollback: vi.fn(),
  commitImportedExternalModelFile: vi.fn(),
  catalogModelFiles: vi.fn(),
  stageManagedModelFiles: vi.fn(),
  finalizeManagedModelFiles: vi.fn(),
  markManagedModelFilesCommitted: vi.fn(),
  rollbackManagedModelFiles: vi.fn(),
  invalidateLocalModelInstallStatusCache: vi.fn(),
  requireLocalWorkspaceOwner: vi.fn(),
  getLocalWorkspacePreferences: vi.fn(),
  userSettingsUpdate: vi.fn(),
}));

vi.mock("@/lib/desktop-runtime", () => ({
  isDesktopRuntime: mocks.isDesktopRuntime,
}));

vi.mock("@/lib/hf-model-catalog", () => ({
  findHfModelEntry: mocks.findHfModelEntry,
}));

vi.mock("@/lib/server/desktop-bridge", () => ({
  bridgeFetch: mocks.bridgeFetch,
  getBridgeDownloadJobs: mocks.getBridgeDownloadJobs,
  requireDesktopBridge: mocks.requireDesktopBridge,
}));

vi.mock("@/lib/server/imported-model-registry", () => ({
  findImportedModel: mocks.findImportedModel,
  modelCachePath: mocks.modelCachePath,
  removeImportedModelIfUnchanged: mocks.removeImportedModel,
  upsertImportedModel: mocks.upsertImportedModel,
  stageImportedExternalModelFile: mocks.stageImportedExternalModelFile,
  rollbackImportedExternalModelFile: mocks.rollbackImportedExternalModelFile,
  finishImportedExternalModelRollback: mocks.finishImportedExternalModelRollback,
  commitImportedExternalModelFile: mocks.commitImportedExternalModelFile,
}));

vi.mock("@/lib/server/local-model-files", () => ({
  ManagedModelCleanupPendingError: class ManagedModelCleanupPendingError extends Error {
    removedFiles = 0;
  },
  catalogModelFiles: mocks.catalogModelFiles,
  stageManagedModelFiles: mocks.stageManagedModelFiles,
  finalizeManagedModelFiles: mocks.finalizeManagedModelFiles,
  markManagedModelFilesCommitted: mocks.markManagedModelFilesCommitted,
  rollbackManagedModelFiles: mocks.rollbackManagedModelFiles,
}));

vi.mock("@/lib/server/local-model-inventory", () => ({
  invalidateLocalModelInstallStatusCache: mocks.invalidateLocalModelInstallStatusCache,
}));

vi.mock("@/lib/server/local-workspace-owner", () => ({
  getLocalWorkspacePreferences: mocks.getLocalWorkspacePreferences,
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: { userSettings: { update: mocks.userSettingsUpdate } },
}));

import { DELETE } from "@/app/api/desktop-runtime/models/[modelId]/route";

const bridge = { url: "http://127.0.0.1:49152", token: "bridge-token" };

let tempRoot: string | null = null;

afterEach(() => {
  vi.useRealTimers();
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function request(modelId: string, body?: Record<string, unknown>) {
  return DELETE(new Request(`http://localhost/api/desktop-runtime/models/${modelId}`, {
    method: "DELETE",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }), {
    params: Promise.resolve({ modelId }),
  });
}

function fileIdentity(filePath: string) {
  const stat = lstatSync(filePath, { bigint: true });
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    sizeBytes: stat.size.toString(),
    modifiedAtNs: stat.mtimeNs.toString(),
  };
}

describe("/api/desktop-runtime/models/[modelId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopRuntime.mockReturnValue(true);
    mocks.requireDesktopBridge.mockReturnValue(bridge);
    mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "owner-1" });
    mocks.getLocalWorkspacePreferences.mockResolvedValue({
      defaultTextModel: "",
      defaultImageModel: "",
    });
    mocks.userSettingsUpdate.mockResolvedValue({});
    mocks.findHfModelEntry.mockReturnValue(null);
    mocks.findImportedModel.mockResolvedValue(undefined);
    mocks.removeImportedModel.mockResolvedValue(undefined);
    mocks.upsertImportedModel.mockResolvedValue(undefined);
    mocks.catalogModelFiles.mockReturnValue([]);
    mocks.stageManagedModelFiles.mockImplementation(async (paths: string[]) =>
      paths.map((originalPath) => ({ originalPath, stagedPath: `${originalPath}.stage` })),
    );
    mocks.finalizeManagedModelFiles.mockResolvedValue(0);
    mocks.markManagedModelFilesCommitted.mockResolvedValue(undefined);
    mocks.rollbackManagedModelFiles.mockResolvedValue(undefined);
    mocks.getBridgeDownloadJobs.mockResolvedValue([]);
    mocks.bridgeFetch.mockImplementation(async (_bridge, endpoint: string) => {
      if (endpoint === "/llama-status" || endpoint === "/sd-status") {
        return Response.json({ running: false });
      }
      return Response.json({ ok: true, acquired: true, released: true, stopped: true });
    });
    mocks.stageImportedExternalModelFile.mockImplementation(async (record) => {
      const identity = record.fileIdentity;
      const stat = lstatSync(record.modelPath, { bigint: true });
      if (!identity
        || stat.dev.toString() !== identity.device
        || stat.ino.toString() !== identity.inode
        || stat.size.toString() !== identity.sizeBytes
        || stat.mtimeNs.toString() !== identity.modifiedAtNs) {
        return {
          originalPath: record.modelPath,
          stagedPath: "",
          journalPath: "",
          hadFile: false,
          preservedChangedFile: true,
        };
      }
      const stagedPath = `${record.modelPath}.test-stage`;
      renameSync(record.modelPath, stagedPath);
      return {
        originalPath: record.modelPath,
        stagedPath,
        journalPath: `${stagedPath}.json`,
        hadFile: true,
        preservedChangedFile: false,
      };
    });
    mocks.commitImportedExternalModelFile.mockImplementation(async (stage) => {
      if (!stage.hadFile) return 0;
      unlinkSync(stage.stagedPath);
      return 1;
    });
    mocks.rollbackImportedExternalModelFile.mockImplementation(async (stage, record) => {
      if (stage.hadFile) renameSync(stage.stagedPath, stage.originalPath);
      return record;
    });
    mocks.finishImportedExternalModelRollback.mockResolvedValue(undefined);
  });

  it("keeps model deletion desktop-only even when the native bridge is unavailable", async () => {
    mocks.isDesktopRuntime.mockReturnValue(false);
    mocks.requireDesktopBridge.mockReturnValue(new Response(null, { status: 503 }));

    const response = await request("llama-model");

    expect(response.status).toBe(404);
    expect(mocks.requireLocalWorkspaceOwner).not.toHaveBeenCalled();
    expect(mocks.stageManagedModelFiles).not.toHaveBeenCalled();
  });

  it("removes catalog files and clears a matching image default", async () => {
    mocks.findHfModelEntry.mockReturnValue({
      id: "sdxl-base-1.0",
      runtimeTarget: "sd-cpp",
      fileName: "sd_xl_base_1.0.safetensors",
    });
    mocks.catalogModelFiles.mockReturnValue([
      { fileName: "sd_xl_base_1.0.safetensors" },
      { fileName: "vae.safetensors" },
    ]);
    mocks.modelCachePath.mockImplementation((_runtime: string, fileName: string) => `/profile/models/sd-cpp/${fileName}`);
    mocks.getLocalWorkspacePreferences.mockResolvedValue({
      defaultTextModel: "",
      defaultImageModel: "sdxl-base-1.0",
    });
    mocks.finalizeManagedModelFiles.mockResolvedValue(4);

    const response = await request("sdxl-base-1.0");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      modelId: "sdxl-base-1.0",
      removedFiles: 4,
      clearedDefaults: ["image"],
    });
    expect(mocks.stageManagedModelFiles).toHaveBeenCalledWith([
      "/profile/models/sd-cpp/sd_xl_base_1.0.safetensors",
      "/profile/models/sd-cpp/sd_xl_base_1.0.safetensors.part",
      "/profile/models/sd-cpp/vae.safetensors",
      "/profile/models/sd-cpp/vae.safetensors.part",
    ]);
    expect(mocks.userSettingsUpdate).toHaveBeenCalledWith({
      where: { userId: "owner-1" },
      data: { defaultImageModel: "" },
    });
    expect(mocks.invalidateLocalModelInstallStatusCache).toHaveBeenCalledOnce();
  });

  it("fails closed before SD deletion when the native bridge is unavailable", async () => {
    mocks.findHfModelEntry.mockReturnValue({
      id: "sdxl-base-1.0",
      runtimeTarget: "sd-cpp",
      fileName: "sd_xl_base_1.0.safetensors",
    });
    mocks.catalogModelFiles.mockReturnValue([{ fileName: "sd_xl_base_1.0.safetensors" }]);
    mocks.modelCachePath.mockReturnValue("/profile/models/sd-cpp/sd_xl_base_1.0.safetensors");
    mocks.requireDesktopBridge.mockReturnValue(new NextResponse(null, { status: 503 }));
    const response = await request("sdxl-base-1.0");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "bridge_unreachable",
      retryable: true,
    });
    expect(mocks.stageManagedModelFiles).not.toHaveBeenCalled();
    expect(mocks.userSettingsUpdate).not.toHaveBeenCalled();
  });

  it("unregisters a local-path import without deleting the user's original file", async () => {
    mocks.findImportedModel.mockResolvedValue({
      id: "imported-sd-cpp-original-12345678",
      source: "local-path",
      runtimeTarget: "sd-cpp",
      modelPath: "/Users/example/models/original.safetensors",
      status: "ready",
    });
    mocks.getLocalWorkspacePreferences.mockResolvedValue({
      defaultTextModel: "",
      defaultImageModel: "imported-sd-cpp-original-12345678",
    });

    const response = await request("imported-sd-cpp-original-12345678");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      unregistered: true,
      preservedExternalFile: true,
      removedFiles: 0,
    });
    expect(mocks.stageManagedModelFiles).toHaveBeenCalledWith([]);
    expect(mocks.removeImportedModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "imported-sd-cpp-original-12345678" }),
    );
  });

  it("deletes an imported external file after explicit confirmation", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "lunery-external-model-delete-"));
    const modelPath = path.join(tempRoot, "original.safetensors");
    writeFileSync(modelPath, "model");
    mocks.findImportedModel.mockResolvedValue({
      id: "imported-sd-cpp-delete-12345678",
      source: "local-path",
      runtimeTarget: "sd-cpp",
      modelPath,
      sizeBytes: 5,
      fileIdentity: fileIdentity(modelPath),
      status: "ready",
    });

    const response = await request("imported-sd-cpp-delete-12345678", {
      deleteExternalFile: true,
      confirmation: EXTERNAL_MODEL_DELETE_CONFIRMATION,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      preservedExternalFile: false,
      removedFiles: 1,
    });
    expect(() => writeFileSync(modelPath, "replacement", { flag: "wx" })).not.toThrow();
  });

  it("unregisters a replaced external file without deleting the replacement", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "lunery-external-model-delete-fail-"));
    const modelPath = tempRoot;
    mocks.findImportedModel.mockResolvedValue({
      id: "imported-sd-cpp-delete-fail-12345678",
      source: "local-path",
      runtimeTarget: "sd-cpp",
      modelPath,
      sizeBytes: 0,
      status: "ready",
    });

    const response = await request("imported-sd-cpp-delete-fail-12345678", {
      deleteExternalFile: true,
      confirmation: EXTERNAL_MODEL_DELETE_CONFIRMATION,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      preservedExternalFile: true,
      warnings: ["external_file_changed_preserved"],
    });
    expect(mocks.removeImportedModel).toHaveBeenCalled();
    expect(() => accessSync(modelPath, constants.F_OK)).not.toThrow();
  });

  it("restores the external file and registry when metadata deletion fails", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "lunery-external-model-rollback-"));
    const modelPath = path.join(tempRoot, "original.safetensors");
    writeFileSync(modelPath, "model");
    const record = {
      id: "imported-sd-cpp-rollback-12345678",
      source: "local-path",
      runtimeTarget: "sd-cpp",
      modelPath,
      sizeBytes: 5,
      fileIdentity: fileIdentity(modelPath),
      status: "ready",
    };
    mocks.findImportedModel.mockResolvedValue(record);
    mocks.removeImportedModel.mockRejectedValueOnce(new Error("registry unavailable"));

    const response = await request(record.id, {
      deleteExternalFile: true,
      confirmation: EXTERNAL_MODEL_DELETE_CONFIRMATION,
    });

    expect(response.status).toBe(500);
    expect(() => accessSync(modelPath, constants.F_OK)).not.toThrow();
    expect(mocks.upsertImportedModel).toHaveBeenCalledWith(record);
  });

  it("does not delete an imported file without the shared confirmation token", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "lunery-external-model-no-confirm-"));
    const modelPath = path.join(tempRoot, "original.safetensors");
    writeFileSync(modelPath, "model");
    mocks.findImportedModel.mockResolvedValue({
      id: "imported-sd-cpp-no-confirm-12345678",
      source: "local-path",
      runtimeTarget: "sd-cpp",
      modelPath,
      status: "ready",
    });

    const response = await request("imported-sd-cpp-no-confirm-12345678", {
      deleteExternalFile: true,
      confirmation: "yes",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      preservedExternalFile: true,
      removedFiles: 0,
    });
    expect(() => accessSync(modelPath, constants.F_OK)).not.toThrow();
  });

  it("fails closed when the native bridge is unavailable", async () => {
    mocks.findHfModelEntry.mockReturnValue({
      id: "llama-model",
      runtimeTarget: "llama-cpp",
      fileName: "model.gguf",
    });
    mocks.catalogModelFiles.mockReturnValue([{ fileName: "model.gguf" }]);
    mocks.modelCachePath.mockImplementation((_runtime: string, fileName: string) => `/profile/models/llama-cpp/${fileName}`);
    mocks.requireDesktopBridge.mockReturnValue(
      NextResponse.json({ error: "bridge unavailable" }, { status: 503 }),
    );
    const response = await request("llama-model");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "bridge_unreachable",
      retryable: true,
    });
    expect(mocks.bridgeFetch).not.toHaveBeenCalled();
    expect(mocks.stageManagedModelFiles).not.toHaveBeenCalled();
  });

  it("fails closed when runtime status probing fails", async () => {
    mocks.findHfModelEntry.mockReturnValue({
      id: "llama-model",
      runtimeTarget: "llama-cpp",
      fileName: "model.gguf",
    });
    mocks.catalogModelFiles.mockReturnValue([{ fileName: "model.gguf" }]);
    mocks.modelCachePath.mockImplementation((_runtime: string, fileName: string) => `/profile/models/llama-cpp/${fileName}`);
    mocks.bridgeFetch.mockRejectedValue(new Error("bridge down"));
    const response = await request("llama-model");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "bridge_unreachable",
      retryable: true,
    });
    expect(mocks.stageManagedModelFiles).not.toHaveBeenCalled();
  });

  it("stops an active imported llama model before removing its cache", async () => {
    const modelId = "imported-llama-cpp-demo-12345678";
    mocks.findImportedModel.mockResolvedValue({
      id: modelId,
      source: "huggingface-url",
      runtimeTarget: "llama-cpp",
      modelPath: "/profile/models/llama-cpp/imported/demo.gguf",
      jobId: "job-1",
      status: "ready",
    });
    let statusCalls = 0;
    mocks.bridgeFetch.mockImplementation(async (_bridge, endpoint: string) => {
      if (endpoint === "/llama-status") {
        statusCalls += 1;
        return Response.json(statusCalls === 1
          ? { running: true, modelId }
          : { running: false, modelId: null });
      }
      return Response.json({ ok: true, acquired: true, released: true });
    });

    const response = await request(modelId);
    expect(response.status).toBe(200);
    expect(mocks.bridgeFetch).toHaveBeenCalledWith(
      bridge,
      "/llama-delete-lease-acquire",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("/profile/models/llama-cpp/imported/demo.gguf"),
      }),
    );
    expect(
      mocks.bridgeFetch.mock.calls.filter(([, endpoint]) => endpoint === "/llama-delete-lease-acquire"),
    ).toHaveLength(2);
    expect(mocks.bridgeFetch).toHaveBeenCalledWith(
      bridge,
      "/llama-status",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.bridgeFetch).toHaveBeenCalledWith(
      bridge,
      "/llama-stop",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.stageManagedModelFiles).toHaveBeenCalledWith([
      "/profile/models/llama-cpp/imported/demo.gguf",
      "/profile/models/llama-cpp/imported/demo.gguf.part",
    ]);
    expect(mocks.bridgeFetch).toHaveBeenCalledWith(
      bridge,
      "/llama-delete-lease-release",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("waits for an active Hugging Face import to cancel before deleting its files", async () => {
    const modelId = "imported-llama-cpp-download-12345678";
    mocks.findImportedModel.mockResolvedValue({
      id: modelId,
      source: "huggingface-url",
      runtimeTarget: "llama-cpp",
      modelPath: "/profile/models/llama-cpp/imported/download.gguf",
      jobId: "job-active",
      status: "downloading",
    });
    mocks.getBridgeDownloadJobs
      .mockResolvedValueOnce([{
        jobId: "job-active",
        status: "downloading",
        destination: "/profile/models/llama-cpp/imported/download.gguf",
      }])
      .mockResolvedValueOnce([{
        jobId: "job-active",
        status: "canceled",
        destination: "/profile/models/llama-cpp/imported/download.gguf",
      }]);
    mocks.bridgeFetch.mockResolvedValue(Response.json({ ok: true, running: false }));

    const response = await request(modelId);

    expect(response.status).toBe(200);
    expect(mocks.bridgeFetch).toHaveBeenCalledWith(
      bridge,
      "/hf-download-cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ jobId: "job-active" }),
      }),
    );
    expect(mocks.getBridgeDownloadJobs).toHaveBeenCalledTimes(2);
    expect(mocks.stageManagedModelFiles).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform !== "win32")("matches active downloads through a symlinked model root", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "lunery-delete-symlink-"));
    const physicalRoot = path.join(tempRoot, "physical-models");
    const logicalRoot = path.join(tempRoot, "logical-models");
    mkdirSync(physicalRoot, { recursive: true });
    symlinkSync(physicalRoot, logicalRoot);
    const logicalPath = path.join(logicalRoot, "download.gguf");
    const physicalPath = path.join(physicalRoot, "download.gguf");
    const modelId = "imported-llama-cpp-symlink-download-12345678";
    mocks.findImportedModel.mockResolvedValue({
      id: modelId,
      source: "huggingface-url",
      runtimeTarget: "llama-cpp",
      modelPath: logicalPath,
      jobId: "job-symlink",
      status: "downloading",
    });
    mocks.getBridgeDownloadJobs
      .mockResolvedValueOnce([{
        jobId: "job-symlink",
        status: "downloading",
        destination: physicalPath,
      }])
      .mockResolvedValueOnce([{
        jobId: "job-symlink",
        status: "canceled",
        destination: physicalPath,
      }]);

    const response = await request(modelId);

    expect(response.status).toBe(200);
    expect(mocks.bridgeFetch).toHaveBeenCalledWith(
      bridge,
      "/hf-download-cancel",
      expect.objectContaining({ body: JSON.stringify({ jobId: "job-symlink" }) }),
    );
  });

  it("finds and settles an active catalog download after client state was lost", async () => {
    const modelPath = "/profile/models/llama-cpp/catalog.gguf";
    mocks.findHfModelEntry.mockReturnValue({
      id: "catalog-model",
      runtimeTarget: "llama-cpp",
      fileName: "catalog.gguf",
    });
    mocks.catalogModelFiles.mockReturnValue([{ fileName: "catalog.gguf" }]);
    mocks.modelCachePath.mockReturnValue(modelPath);
    mocks.getBridgeDownloadJobs
      .mockResolvedValueOnce([{
        jobId: "catalog-job",
        status: "downloading",
        destination: modelPath,
      }])
      .mockResolvedValueOnce([{
        jobId: "catalog-job",
        status: "canceled",
        destination: modelPath,
      }]);

    const response = await request("catalog-model");

    expect(response.status).toBe(200);
    expect(mocks.bridgeFetch).toHaveBeenCalledWith(
      bridge,
      "/hf-download-delete-lease-acquire",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.bridgeFetch).toHaveBeenCalledWith(
      bridge,
      "/hf-download-cancel",
      expect.objectContaining({ body: JSON.stringify({ jobId: "catalog-job" }) }),
    );
    expect(mocks.bridgeFetch).toHaveBeenCalledWith(
      bridge,
      "/hf-download-delete-lease-release",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.stageManagedModelFiles).toHaveBeenCalledOnce();
  });

  it("refuses deletion when an active Hugging Face import does not settle", async () => {
    const modelId = "imported-llama-cpp-download-timeout-12345678";
    mocks.findImportedModel.mockResolvedValue({
      id: modelId,
      source: "huggingface-url",
      runtimeTarget: "llama-cpp",
      modelPath: "/profile/models/llama-cpp/imported/download.gguf",
      jobId: "job-stuck",
      status: "downloading",
    });
    mocks.getBridgeDownloadJobs.mockResolvedValue([{
      jobId: "job-stuck",
      status: "downloading",
      destination: "/profile/models/llama-cpp/imported/download.gguf",
    }]);
    mocks.bridgeFetch.mockResolvedValue(Response.json({ ok: true }));

    const response = await request(modelId);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "download_cancel_timeout",
      retryable: true,
    });
    expect(mocks.stageManagedModelFiles).not.toHaveBeenCalled();
  }, 10_000);

  it("stops an active SD model before removing its cache", async () => {
    const modelId = "imported-sd-cpp-demo-12345678";
    const modelPath = "/profile/models/sd-cpp/imported/demo.safetensors";
    mocks.findImportedModel.mockResolvedValue({
      id: modelId,
      source: "huggingface-url",
      runtimeTarget: "sd-cpp",
      modelPath,
      status: "ready",
    });
    mocks.bridgeFetch.mockImplementation(async (_bridge, endpoint: string) => {
      if (endpoint === "/sd-status") return Response.json({ running: true, modelPath });
      return Response.json({ ok: true, acquired: true, released: true, stopped: true });
    });

    const response = await request(modelId);

    expect(response.status).toBe(200);
    expect(mocks.bridgeFetch).toHaveBeenCalledWith(
      bridge,
      "/sd-delete-lease-acquire",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(modelPath),
      }),
    );
    expect(mocks.bridgeFetch).toHaveBeenCalledWith(
      bridge,
      "/sd-status",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.bridgeFetch).toHaveBeenCalledWith(
      bridge,
      "/sd-stop",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ modelPath }),
      }),
    );
    expect(mocks.stageManagedModelFiles).toHaveBeenCalledWith([
      modelPath,
      `${modelPath}.part`,
    ]);
    expect(mocks.bridgeFetch).toHaveBeenCalledWith(
      bridge,
      "/sd-delete-lease-release",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("refuses deletion when a matching SD runtime cannot be stopped", async () => {
    const modelId = "imported-sd-cpp-busy-12345678";
    const modelPath = "/profile/models/sd-cpp/imported/busy.safetensors";
    mocks.findImportedModel.mockResolvedValue({
      id: modelId,
      source: "huggingface-url",
      runtimeTarget: "sd-cpp",
      modelPath,
      status: "ready",
    });
    mocks.bridgeFetch.mockImplementation(async (_bridge, endpoint: string) => {
      if (endpoint === "/sd-status") return Response.json({ running: true, modelPath });
      if (endpoint === "/sd-stop") return Response.json({ ok: true, stopped: false });
      return Response.json({ ok: true, acquired: true, released: true });
    });

    const response = await request(modelId);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "runtime_stop_failed",
      retryable: true,
    });
    expect(mocks.stageManagedModelFiles).not.toHaveBeenCalled();
  });

  it("fails closed when a lease cannot be renewed after runtime settlement", async () => {
    const modelId = "imported-llama-cpp-renew-12345678";
    const modelPath = "/profile/models/llama-cpp/imported/renew.gguf";
    mocks.findImportedModel.mockResolvedValue({
      id: modelId,
      source: "huggingface-url",
      runtimeTarget: "llama-cpp",
      modelPath,
      status: "ready",
    });
    let acquireCalls = 0;
    mocks.bridgeFetch.mockImplementation(async (_bridge, endpoint: string) => {
      if (endpoint === "/llama-delete-lease-acquire") {
        acquireCalls += 1;
        return acquireCalls === 1
          ? Response.json({ ok: true, acquired: true })
          : Response.json({ ok: false }, { status: 409 });
      }
      if (endpoint === "/llama-status") return Response.json({ running: false });
      return Response.json({ ok: true, released: true });
    });

    const response = await request(modelId);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "model_delete_lease_expired",
      retryable: true,
    });
    expect(mocks.stageManagedModelFiles).not.toHaveBeenCalled();
    expect(mocks.removeImportedModel).not.toHaveBeenCalled();
  });

  it("heartbeats every delete lease across a stalled stage beyond the native TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    const modelId = "imported-llama-cpp-heartbeat-12345678";
    const modelPath = "/profile/models/llama-cpp/imported/heartbeat.gguf";
    mocks.findImportedModel.mockResolvedValue({
      id: modelId,
      source: "huggingface-url",
      runtimeTarget: "llama-cpp",
      modelPath,
      status: "ready",
    });
    let leaseExpiresAt = 0;
    mocks.bridgeFetch.mockImplementation(async (_bridge, endpoint: string) => {
      if (endpoint.endsWith("delete-lease-acquire")) {
        leaseExpiresAt = Date.now() + 60_000;
        return Response.json({ ok: true, acquired: true });
      }
      if (endpoint === "/hf-download-start" || endpoint === "/llama-start") {
        return Date.now() < leaseExpiresAt
          ? Response.json({ error: "model delete in progress" }, { status: 409 })
          : Response.json({ ok: true });
      }
      if (endpoint === "/llama-status") return Response.json({ running: false });
      return Response.json({ ok: true, released: true });
    });
    let finishStage!: (value: Array<{ originalPath: string; stagedPath: string }>) => void;
    mocks.stageManagedModelFiles.mockImplementation(() => new Promise((resolve) => {
      finishStage = resolve;
    }));

    const deletion = request(modelId);
    await vi.waitFor(() => expect(mocks.stageManagedModelFiles).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(75_000);

    const [downloadStart, runtimeStart] = await Promise.all([
      mocks.bridgeFetch(bridge, "/hf-download-start"),
      mocks.bridgeFetch(bridge, "/llama-start"),
    ]);
    expect(downloadStart.status).toBe(409);
    expect(runtimeStart.status).toBe(409);
    finishStage([{ originalPath: modelPath, stagedPath: `${modelPath}.stage` }]);
    await expect(deletion).resolves.toMatchObject({ status: 200 });
    expect(mocks.bridgeFetch.mock.calls.filter(([, endpoint]) =>
      String(endpoint).endsWith("delete-lease-acquire")).length).toBeGreaterThanOrEqual(7);
  });

  it("rolls managed files and defaults back when registry metadata removal fails", async () => {
    const modelId = "imported-llama-cpp-metadata-12345678";
    const modelPath = "/profile/models/llama-cpp/imported/metadata.gguf";
    const staged = [
      { originalPath: modelPath, stagedPath: `${modelPath}.stage` },
      { originalPath: `${modelPath}.part`, stagedPath: `${modelPath}.part.stage` },
    ];
    mocks.findImportedModel.mockResolvedValue({
      id: modelId,
      source: "huggingface-url",
      runtimeTarget: "llama-cpp",
      modelPath,
      status: "ready",
    });
    mocks.getLocalWorkspacePreferences.mockResolvedValue({
      defaultTextModel: modelId,
      defaultImageModel: "",
    });
    mocks.stageManagedModelFiles.mockResolvedValue(staged);
    mocks.removeImportedModel.mockRejectedValueOnce(new Error("registry unavailable"));

    const response = await request(modelId);

    expect(response.status).toBe(500);
    expect(mocks.rollbackManagedModelFiles).toHaveBeenCalledWith(staged);
    expect(mocks.finalizeManagedModelFiles).not.toHaveBeenCalled();
    expect(mocks.userSettingsUpdate).toHaveBeenNthCalledWith(1, {
      where: { userId: "owner-1" },
      data: { defaultTextModel: "" },
    });
    expect(mocks.userSettingsUpdate).toHaveBeenNthCalledWith(2, {
      where: { userId: "owner-1" },
      data: { defaultTextModel: modelId },
    });
  });

  it("rolls metadata and staged bytes back when committed-marker publication fails", async () => {
    const modelId = "imported-llama-cpp-marker-12345678";
    const modelPath = "/profile/models/llama-cpp/imported/marker.gguf";
    const staged = [{ originalPath: modelPath, stagedPath: `${modelPath}.stage` }];
    const imported = {
      id: modelId,
      source: "huggingface-url",
      runtimeTarget: "llama-cpp",
      modelPath,
      status: "ready",
    };
    mocks.findImportedModel.mockResolvedValue(imported);
    mocks.getLocalWorkspacePreferences.mockResolvedValue({
      defaultTextModel: modelId,
      defaultImageModel: "",
    });
    mocks.stageManagedModelFiles.mockResolvedValue(staged);
    mocks.markManagedModelFilesCommitted.mockRejectedValueOnce(new Error("marker publish failed"));

    const response = await request(modelId);

    expect(response.status).toBe(500);
    expect(mocks.rollbackManagedModelFiles).toHaveBeenCalledWith(staged);
    expect(mocks.upsertImportedModel).toHaveBeenCalledWith(imported);
    expect(mocks.userSettingsUpdate).toHaveBeenLastCalledWith({
      where: { userId: "owner-1" },
      data: { defaultTextModel: modelId },
    });
    expect(mocks.finalizeManagedModelFiles).not.toHaveBeenCalled();
  });

  it("reports logical success with retryable staged cleanup after metadata commits", async () => {
    const modelId = "imported-llama-cpp-cleanup-12345678";
    const modelPath = "/profile/models/llama-cpp/imported/cleanup.gguf";
    mocks.findImportedModel.mockResolvedValue({
      id: modelId,
      source: "huggingface-url",
      runtimeTarget: "llama-cpp",
      modelPath,
      status: "ready",
    });
    mocks.finalizeManagedModelFiles.mockRejectedValueOnce(new Error("unlink failed"));

    const response = await request(modelId);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      cleanupPending: true,
      warnings: ["managed_file_cleanup_pending"],
    });
    expect(mocks.removeImportedModel).toHaveBeenCalledOnce();
  });

  it("rejects malformed ids before looking up a model", async () => {
    const response = await request("../outside");
    expect(response.status).toBe(400);
    expect(mocks.findHfModelEntry).not.toHaveBeenCalled();
    expect(mocks.findImportedModel).not.toHaveBeenCalled();
  });
});
