import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  jobFindMany: vi.fn(),
  taskFindMany: vi.fn(),
  isDesktopRuntime: vi.fn(),
  fetchDesktopStatusSnapshot: vi.fn(),
  getStorageBreakdown: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    generationJob: { findMany: mocks.jobFindMany },
    agentTask: { findMany: mocks.taskFindMany },
  },
}));
vi.mock("@/lib/desktop-runtime", () => ({ isDesktopRuntime: mocks.isDesktopRuntime }));
vi.mock("@/lib/server/byok-shared", () => ({
  fetchDesktopStatusSnapshot: mocks.fetchDesktopStatusSnapshot,
}));
vi.mock("@/lib/server/storage-breakdown", () => ({
  getStorageBreakdown: mocks.getStorageBreakdown,
}));

import { buildDiagnosticsBundle } from "@/lib/server/diagnostics";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isDesktopRuntime.mockReturnValue(true);
  mocks.getStorageBreakdown.mockResolvedValue({
    activeBytes: 1,
    trashBytes: 0,
    modelsBytes: 0,
    logsBytes: 0,
    freeDiskBytes: 10,
  });
  mocks.fetchDesktopStatusSnapshot.mockResolvedValue({
    providers: [
      { id: "openai", configured: true },
      { id: "fal", configured: false },
    ],
    local_runtimes: [{ id: "sd-cpp", endpoint: "embedded", status: "ready" }],
  });
  mocks.jobFindMany.mockResolvedValue([]);
  mocks.taskFindMany.mockResolvedValue([]);
});

describe("buildDiagnosticsBundle", () => {
  it("excludes secrets and only lists configured providers + runtime status", async () => {
    const bundle = await buildDiagnosticsBundle("user-1");

    expect(bundle.excluded).toEqual(["api-keys", "prompts", "reference-images", "generated-media"]);
    expect(bundle.runtime?.configuredProviders).toEqual(["openai"]); // fal not configured
    expect(bundle.runtime?.localRuntimes).toEqual([{ id: "sd-cpp", status: "ready" }]);
    expect(bundle.app.platform).toBe(process.platform);
    expect(mocks.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", origin: "USER" } }),
    );
    // No endpoint leakage in the runtime section.
    expect(JSON.stringify(bundle.runtime)).not.toContain("embedded");
  });

  it("surfaces job error codes and redacts home paths in endpoints, without prompts", async () => {
    vi.stubEnv("HOME", "/home/alice");
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "j1",
        type: "image",
        status: "FAILED",
        provider: "local-comfyui",
        model: "sdxl",
        endpoint: "http://127.0.0.1:8188/home/alice/x",
        errorCode: "provider_error",
        createdAt: new Date("2026-07-15T00:00:00Z"),
        completedAt: null,
      },
    ]);

    const bundle = await buildDiagnosticsBundle("user-1");
    const job = bundle.recentJobs[0]!;
    expect(job.errorCode).toBe("provider_error");
    expect(job.endpoint).toBe("http://127.0.0.1:8188~/x");
    expect(JSON.stringify(bundle)).not.toContain("/home/alice");
    vi.unstubAllEnvs();
  });

  it("extracts only a short code from agent task error json (never the body)", async () => {
    mocks.taskFindMany.mockResolvedValue([
      {
        id: "t1",
        status: "FAILED",
        error: { code: "tool_failed", message: "secret prompt echo that must not leak" },
        createdAt: new Date("2026-07-15T00:00:00Z"),
      },
    ]);

    const bundle = await buildDiagnosticsBundle("user-1");
    expect(bundle.recentAgentTasks[0]!.errorCode).toBe("tool_failed");
    expect(JSON.stringify(bundle)).not.toContain("secret prompt echo");
  });

  it("reports null runtime in non-desktop mode", async () => {
    mocks.isDesktopRuntime.mockReturnValue(false);
    const bundle = await buildDiagnosticsBundle("user-1");
    expect(bundle.runtime).toBeNull();
    expect(mocks.fetchDesktopStatusSnapshot).not.toHaveBeenCalled();
  });
});
