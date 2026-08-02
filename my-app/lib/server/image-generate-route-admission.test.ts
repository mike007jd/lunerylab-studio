import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireLocalWorkspaceOwner: vi.fn(),
  ensureAppState: vi.fn(),
  telemetryStart: vi.fn(),
  telemetryFailed: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/local-workspace-owner", () => ({
  requireLocalWorkspaceOwner: mocks.requireLocalWorkspaceOwner,
}));
vi.mock("@/lib/server/app-state", () => ({ ensureAppState: mocks.ensureAppState }));
vi.mock("@/lib/server/route-telemetry", () => ({
  createRouteTelemetry: () => ({
    start: mocks.telemetryStart,
    done: vi.fn(),
    failed: mocks.telemetryFailed,
  }),
}));

import { POST } from "@/app/api/generate/images/route";
import {
  acquireWorkspaceExclusive,
  resetWorkspaceOperationGateForTests,
} from "@/lib/server/workspace-operation-gate";

describe("image generation workspace admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkspaceOperationGateForTests();
    mocks.requireLocalWorkspaceOwner.mockResolvedValue({ id: "owner" });
  });

  it("returns retryable workspace_busy without an out-of-lease app-state write", async () => {
    const exclusive = await acquireWorkspaceExclusive("restore");
    try {
      const response = await POST(new NextRequest("http://localhost/api/generate/images", {
        method: "POST",
        body: new FormData(),
      }));
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "workspace_busy",
        retryable: true,
      });
      expect(mocks.ensureAppState).not.toHaveBeenCalled();
    } finally {
      exclusive.release();
    }
  });
});
