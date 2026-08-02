import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  getLocalWorkspacePreferences: vi.fn(),
  update: vi.fn(),
  resolveImageModelEntry: vi.fn(),
  resolveVideoModelEntry: vi.fn(),
  getProviderStatus: vi.fn(),
  getByokConnectionMeta: vi.fn(),
  listLocalModelInstallStatuses: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
  getLocalWorkspacePreferences: mocks.getLocalWorkspacePreferences,
}));
vi.mock("@/lib/server/prisma", () => ({
  prisma: { userSettings: { update: mocks.update } },
}));
vi.mock("@/lib/server/model-catalog", () => ({
  resolveImageModelEntry: mocks.resolveImageModelEntry,
  resolveVideoModelEntry: mocks.resolveVideoModelEntry,
}));
vi.mock("@/lib/server/api-keys", () => ({ getProviderStatus: mocks.getProviderStatus }));
vi.mock("@/lib/server/byok-connection-store", () => ({
  getByokConnectionMeta: mocks.getByokConnectionMeta,
}));
vi.mock("@/lib/server/local-model-inventory", () => ({
  listLocalModelInstallStatuses: mocks.listLocalModelInstallStatuses,
}));

import { GET, PATCH } from "@/app/api/settings/route";
import {
  acquireWorkspaceExclusive,
  getWorkspaceOperationGateStateForTests,
  resetWorkspaceOperationGateForTests,
  withWorkspaceExclusive,
} from "@/lib/server/workspace-operation-gate";

function patch(defaultTextModel: string) {
  return PATCH(new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultTextModel }),
  }));
}

describe("settings text-model server validation", () => {
  beforeEach(() => {
    resetWorkspaceOperationGateForTests();
    vi.clearAllMocks();
    mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "owner" });
    mocks.update.mockResolvedValue({
      defaultLocale: "en",
      defaultTextModel: "",
      defaultImageModel: "",
      defaultVideoModel: "",
    });
    mocks.getProviderStatus.mockResolvedValue({});
    mocks.listLocalModelInstallStatuses.mockResolvedValue([]);
  });

  it("fails closed without reading split settings/config state while restore is paused", async () => {
    const exclusive = await acquireWorkspaceExclusive("restore");
    try {
      const response = await GET();
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: "workspace_busy" });
      expect(mocks.getLocalWorkspacePreferences).not.toHaveBeenCalled();
      expect(mocks.getProviderStatus).not.toHaveBeenCalled();
    } finally {
      exclusive.release();
    }
  });

  it("rejects a forged local id that is absent from installed inventory", async () => {
    const response = await patch("local:forged-model");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_model" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects a BYOK id that differs from the provider's configured text model", async () => {
    mocks.getProviderStatus.mockResolvedValue({ openai: { configured: true, source: "keychain" } });
    mocks.getByokConnectionMeta.mockReturnValue({
      endpoint: "https://api.openai.com/v1",
      models: { text: "gpt-5.6" },
      updatedAt: new Date(0).toISOString(),
    });
    const response = await patch("byok:openai:forged-model");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_model" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects an exact BYOK connection whose provider is not currently configured", async () => {
    mocks.getProviderStatus.mockResolvedValue({ openai: { configured: false, source: null } });
    mocks.getByokConnectionMeta.mockReturnValue({
      endpoint: "https://api.openai.com/v1",
      models: { text: "gpt-5.6" },
      updatedAt: new Date(0).toISOString(),
    });
    const response = await patch("byok:openai:gpt-5.6");
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("keeps provider validation and the settings write in one shared lease", async () => {
    let releaseValidation!: () => void;
    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    mocks.getProviderStatus
      .mockImplementationOnce(async () => {
        validationStarted();
        await new Promise<void>((resolve) => {
          releaseValidation = resolve;
        });
        return { openai: { configured: true, source: "keychain" } };
      })
      .mockResolvedValueOnce({ openai: { configured: true, source: "keychain" } });
    mocks.getByokConnectionMeta.mockReturnValue({
      endpoint: "https://api.openai.com/v1",
      models: { text: "gpt-5.6" },
      updatedAt: new Date(0).toISOString(),
    });
    mocks.update.mockResolvedValue({
      defaultLocale: "en",
      defaultTextModel: "byok:openai:gpt-5.6",
      defaultImageModel: "",
      defaultVideoModel: "",
    });

    const settingsWrite = patch("byok:openai:gpt-5.6");
    await started;
    const unlinkExclusive = acquireWorkspaceExclusive("provider-unlink");
    await vi.waitFor(() => {
      expect(getWorkspaceOperationGateStateForTests().exclusivePending).toBe(true);
    });
    expect(mocks.update).not.toHaveBeenCalled();

    releaseValidation();
    const response = await settingsWrite;
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledOnce();

    const exclusive = await unlinkExclusive;
    exclusive.release();
  });

  it("accepts only an installed planner model's exact local id", async () => {
    mocks.listLocalModelInstallStatuses.mockResolvedValue([
      { id: "qwen", installed: true, capability: "planner-llm" },
    ]);
    mocks.update.mockResolvedValue({
      defaultLocale: "en",
      defaultTextModel: "local:qwen",
      defaultImageModel: "",
      defaultVideoModel: "",
    });
    const response = await patch("local:qwen");
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { defaultTextModel: "local:qwen" },
    }));
  });

  it("holds validation through commit so an in-flight model deletion waits then clears it", async () => {
    let releaseInventory!: () => void;
    const inventoryBlocked = new Promise<void>((resolve) => {
      releaseInventory = resolve;
    });
    let validationStarted!: () => void;
    const validationReady = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    mocks.listLocalModelInstallStatuses.mockImplementation(async () => {
      validationStarted();
      await inventoryBlocked;
      return [{ id: "qwen", installed: true, capability: "planner-llm" }];
    });
    mocks.update.mockResolvedValue({
      defaultLocale: "en",
      defaultTextModel: "local:qwen",
      defaultImageModel: "",
      defaultVideoModel: "",
    });

    const settingsCommit = patch("local:qwen");
    await validationReady;
    let deletionEntered = false;
    const deletion = withWorkspaceExclusive("model-delete", async () => {
      deletionEntered = true;
    });
    await Promise.resolve();
    expect(deletionEntered).toBe(false);

    releaseInventory();
    await expect(settingsCommit).resolves.toMatchObject({ status: 200 });
    await deletion;
    expect(deletionEntered).toBe(true);
  });

  it("rejects a stale local default while model deletion owns exclusivity", async () => {
    const deletion = await acquireWorkspaceExclusive("model-delete");
    try {
      const response = await patch("local:qwen");
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: "workspace_busy" });
      expect(mocks.listLocalModelInstallStatuses).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    } finally {
      deletion.release();
    }
  });

  it("revalidates inventory after a completed model deletion", async () => {
    await withWorkspaceExclusive("model-delete", async () => undefined);
    mocks.listLocalModelInstallStatuses.mockResolvedValue([]);

    const response = await patch("local:qwen");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_model" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
