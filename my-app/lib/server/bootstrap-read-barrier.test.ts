import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getLocalWorkspacePreferences: vi.fn(),
  getProviderStatus: vi.fn(),
  listByokConnectionMeta: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/server/local-workspace-owner", () => ({
  getLocalWorkspacePreferences: mocks.getLocalWorkspacePreferences,
}));
vi.mock("@/lib/server/api-keys", () => ({
  getProviderStatus: mocks.getProviderStatus,
}));
vi.mock("@/lib/server/byok-connection-store", () => ({
  listByokConnectionMeta: mocks.listByokConnectionMeta,
}));

import { fetchBootstrapData } from "@/lib/server/queries";
import {
  acquireWorkspaceExclusive,
  getWorkspaceOperationGateStateForTests,
  resetWorkspaceOperationGateForTests,
} from "@/lib/server/workspace-operation-gate";

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkspaceOperationGateForTests();
  mocks.getProviderStatus.mockResolvedValue({});
  mocks.listByokConnectionMeta.mockReturnValue({});
});

describe("bootstrap workspace snapshot", () => {
  it("does not mix database settings with post-restore profile metadata", async () => {
    let releaseSettings!: () => void;
    let settingsReadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      settingsReadStarted = resolve;
    });
    mocks.getLocalWorkspacePreferences.mockImplementation(async () => {
      settingsReadStarted();
      await new Promise<void>((resolve) => {
        releaseSettings = resolve;
      });
      return {
        defaultLocale: "en",
        defaultTextModel: "",
        defaultImageModel: "",
        defaultVideoModel: "",
      };
    });

    const bootstrap = fetchBootstrapData("owner");
    await started;
    const restore = acquireWorkspaceExclusive("restore");
    await vi.waitFor(() => {
      expect(getWorkspaceOperationGateStateForTests().exclusivePending).toBe(true);
    });
    expect(mocks.listByokConnectionMeta).not.toHaveBeenCalled();

    releaseSettings();
    await expect(bootstrap).resolves.toMatchObject({ providerConnections: {} });
    expect(mocks.listByokConnectionMeta).toHaveBeenCalledOnce();

    const exclusive = await restore;
    exclusive.release();
  });
});
