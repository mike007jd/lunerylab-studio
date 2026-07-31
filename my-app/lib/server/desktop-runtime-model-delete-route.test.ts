import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessSync, constants, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { EXTERNAL_MODEL_DELETE_CONFIRMATION } from "@/lib/desktop-external-model-delete";

const mocks = vi.hoisted(() => ({
  isDesktopRuntime: vi.fn(),
  findHfModelEntry: vi.fn(),
  bridgeFetch: vi.fn(),
  getBridgeDownloadStatus: vi.fn(),
  requireDesktopBridge: vi.fn(),
  findImportedModel: vi.fn(),
  modelCachePath: vi.fn(),
  removeImportedModel: vi.fn(),
  upsertImportedModel: vi.fn(),
  catalogModelFiles: vi.fn(),
  removeManagedModelFiles: vi.fn(),
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
  getBridgeDownloadStatus: mocks.getBridgeDownloadStatus,
  requireDesktopBridge: mocks.requireDesktopBridge,
}));

vi.mock("@/lib/server/imported-model-registry", () => ({
  findImportedModel: mocks.findImportedModel,
  modelCachePath: mocks.modelCachePath,
  removeImportedModel: mocks.removeImportedModel,
  upsertImportedModel: mocks.upsertImportedModel,
}));

vi.mock("@/lib/server/local-model-files", () => ({
  catalogModelFiles: mocks.catalogModelFiles,
  removeManagedModelFiles: mocks.removeManagedModelFiles,
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
    mocks.removeManagedModelFiles.mockResolvedValue(0);
    mocks.getBridgeDownloadStatus.mockResolvedValue({ status: "ready" });
    mocks.bridgeFetch.mockResolvedValue(Response.json({ ok: true }));
  });

  it("keeps model deletion desktop-only even when the native bridge is unavailable", async () => {
    mocks.isDesktopRuntime.mockReturnValue(false);
    mocks.requireDesktopBridge.mockReturnValue(new Response(null, { status: 503 }));

    const response = await request("llama-model");

    expect(response.status).toBe(404);
    expect(mocks.requireLocalWorkspaceOwner).not.toHaveBeenCalled();
    expect(mocks.removeManagedModelFiles).not.toHaveBeenCalled();
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
    mocks.removeManagedModelFiles.mockResolvedValue(4);

    const response = await request("sdxl-base-1.0");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      modelId: "sdxl-base-1.0",
      removedFiles: 4,
      clearedDefaults: ["image"],
    });
    expect(mocks.removeManagedModelFiles).toHaveBeenCalledWith([
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

  it("does not turn a missing bridge probe into permission to block SD deletion", async () => {
    mocks.findHfModelEntry.mockReturnValue({
      id: "sdxl-base-1.0",
      runtimeTarget: "sd-cpp",
      fileName: "sd_xl_base_1.0.safetensors",
    });
    mocks.catalogModelFiles.mockReturnValue([{ fileName: "sd_xl_base_1.0.safetensors" }]);
    mocks.modelCachePath.mockReturnValue("/profile/models/sd-cpp/sd_xl_base_1.0.safetensors");
    mocks.requireDesktopBridge.mockReturnValue(new NextResponse(null, { status: 503 }));
    mocks.removeManagedModelFiles.mockResolvedValue(1);

    const response = await request("sdxl-base-1.0");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      removedFiles: 1,
      warnings: ["runtime_not_stopped"],
    });
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
    expect(mocks.removeManagedModelFiles).toHaveBeenCalledWith([]);
    expect(mocks.removeImportedModel).toHaveBeenCalledWith("imported-sd-cpp-original-12345678");
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

  it("refuses a confirmed external delete when the imported path was replaced", async () => {
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

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "external_model_file_changed",
      retryable: false,
    });
    expect(mocks.removeImportedModel).not.toHaveBeenCalled();
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

  it("continues deletion when the native bridge is unavailable and reports residual risk", async () => {
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
    mocks.removeManagedModelFiles.mockResolvedValue(2);

    const response = await request("llama-model");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      removedFiles: 2,
      warnings: ["runtime_not_stopped"],
    });
    expect(mocks.bridgeFetch).not.toHaveBeenCalled();
  });

  it("continues deletion when runtime status probing fails and reports the residual risk", async () => {
    mocks.findHfModelEntry.mockReturnValue({
      id: "llama-model",
      runtimeTarget: "llama-cpp",
      fileName: "model.gguf",
    });
    mocks.catalogModelFiles.mockReturnValue([{ fileName: "model.gguf" }]);
    mocks.modelCachePath.mockImplementation((_runtime: string, fileName: string) => `/profile/models/llama-cpp/${fileName}`);
    mocks.bridgeFetch.mockRejectedValue(new Error("bridge down"));
    mocks.removeManagedModelFiles.mockResolvedValue(2);

    const response = await request("llama-model");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      removedFiles: 2,
      warnings: ["runtime_not_stopped"],
    });
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
    mocks.getBridgeDownloadStatus.mockResolvedValue({ status: "ready" });
    mocks.bridgeFetch
      .mockResolvedValueOnce(Response.json({ running: true, modelId }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const response = await request(modelId);
    expect(response.status).toBe(200);
    expect(mocks.bridgeFetch).toHaveBeenNthCalledWith(
      1,
      bridge,
      "/llama-status",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.bridgeFetch).toHaveBeenNthCalledWith(
      2,
      bridge,
      "/llama-stop",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.removeManagedModelFiles).toHaveBeenCalledWith([
      "/profile/models/llama-cpp/imported/demo.gguf",
      "/profile/models/llama-cpp/imported/demo.gguf.part",
    ]);
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
    mocks.getBridgeDownloadStatus
      .mockResolvedValueOnce({ status: "downloading" })
      .mockResolvedValueOnce({ status: "canceled" });
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
    expect(mocks.getBridgeDownloadStatus).toHaveBeenCalledTimes(2);
    expect(mocks.removeManagedModelFiles).toHaveBeenCalledOnce();
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
    mocks.getBridgeDownloadStatus.mockResolvedValue({ status: "downloading" });
    mocks.bridgeFetch.mockResolvedValue(Response.json({ ok: true }));

    const response = await request(modelId);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "download_cancel_timeout",
      retryable: true,
    });
    expect(mocks.removeManagedModelFiles).not.toHaveBeenCalled();
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
    mocks.bridgeFetch
      .mockResolvedValueOnce(Response.json({ running: true, modelPath }))
      .mockResolvedValueOnce(Response.json({ ok: true, stopped: true }));

    const response = await request(modelId);

    expect(response.status).toBe(200);
    expect(mocks.bridgeFetch).toHaveBeenNthCalledWith(
      1,
      bridge,
      "/sd-status",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.bridgeFetch).toHaveBeenNthCalledWith(
      2,
      bridge,
      "/sd-stop",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ modelPath }),
      }),
    );
    expect(mocks.removeManagedModelFiles).toHaveBeenCalledWith([
      modelPath,
      `${modelPath}.part`,
    ]);
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
    mocks.bridgeFetch
      .mockResolvedValueOnce(Response.json({ running: true, modelPath }))
      .mockResolvedValueOnce(Response.json({ ok: true, stopped: false }));

    const response = await request(modelId);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "runtime_stop_failed",
      retryable: true,
    });
    expect(mocks.removeManagedModelFiles).not.toHaveBeenCalled();
  });

  it("rejects malformed ids before looking up a model", async () => {
    const response = await request("../outside");
    expect(response.status).toBe(400);
    expect(mocks.findHfModelEntry).not.toHaveBeenCalled();
    expect(mocks.findImportedModel).not.toHaveBeenCalled();
  });
});
