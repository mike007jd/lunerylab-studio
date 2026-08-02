import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const events: string[] = [];
const mocks = vi.hoisted(() => ({
  workspaceCommitFind: vi.fn(),
  workspaceCommitDelete: vi.fn(),
  userFind: vi.fn(),
  assetFindMany: vi.fn(),
  prepareImageFiles: vi.fn(),
  requireWritableCanvasSession: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/desktop-runtime", () => ({ isDesktopRuntime: () => true }));
vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    workspaceRestoreCommit: {
      findUnique: mocks.workspaceCommitFind,
      deleteMany: mocks.workspaceCommitDelete,
    },
    user: { findUnique: mocks.userFind, create: vi.fn() },
    asset: { findMany: mocks.assetFindMany },
  },
}));
vi.mock("@/lib/server/imported-model-registry", () => ({
  reconcileExternalModelDeleteJournals: vi.fn().mockResolvedValue(undefined),
  modelCachePath: (runtime: string, fileName: string) => `/profile/models/${runtime}/${fileName}`,
  modelsCacheRoot: () => "/profile/models",
}));
vi.mock("@/lib/server/local-model-files", () => ({
  reconcileStagedManagedModelFiles: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/server/sample-projects", () => ({
  ensureBuiltInProjectTemplates: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/server/storage", () => ({
  reconcileStagedStoredFileDeletions: vi.fn().mockResolvedValue(undefined),
  writeReferenceFile: vi.fn().mockResolvedValue({
    storagePath: "uploads/cold.webp",
    mimeType: "image/webp",
    byteSize: 5,
    width: 1,
    height: 1,
    buffer: Buffer.from("image"),
  }),
  deleteStoredFile: vi.fn().mockResolvedValue(undefined),
  writeFilesOrCleanup: vi.fn(),
  writeGeneratedImage: vi.fn(),
}));
vi.mock("@/lib/server/file-validation", () => ({
  assertRequestContentLength: vi.fn(),
  prepareImageFiles: mocks.prepareImageFiles,
  withAssetWriteTransaction: async (operation: (tx: unknown) => Promise<unknown>) => {
    events.push("route-mutation");
    return operation({
      generationJob: { create: vi.fn().mockResolvedValue({ id: "job" }) },
      asset: { create: vi.fn().mockResolvedValue({
        id: "asset",
        projectId: null,
        modality: "IMAGE",
        format: null,
        durationSeconds: null,
        tags: [],
        isFavorite: false,
        note: null,
        summary: null,
        agentTaskId: null,
        parentAssetId: null,
        deletedAt: null,
        createdAt: new Date(0),
      }) },
    });
  },
}));
vi.mock("@/lib/server/project-ownership", () => ({
  resolveOwnedProjectId: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/server/canvas-session-access", () => ({
  requireWritableCanvasSession: mocks.requireWritableCanvasSession,
}));
vi.mock("@/lib/server/dto", () => ({ toAssetDTO: (value: unknown) => value }));

let tempRoot: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  events.length = 0;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lunery-cold-route-"));
  vi.stubEnv("LUNERY_DESKTOP", "1");
  vi.stubEnv("LUNERY_HOME", tempRoot);
  vi.stubEnv("LUNERY_DATA_DIR", path.join(tempRoot, "data"));
  vi.stubEnv("LUNERY_CONFIG_DIR", path.join(tempRoot, "config"));
  vi.stubEnv("LUNERY_MEDIA_DIR", path.join(tempRoot, "data", "media"));
  vi.stubEnv("LUNERY_MODELS_DIR", path.join(tempRoot, "models"));
  vi.stubEnv("LUNERY_RUNTIME_DIR", path.join(tempRoot, "runtime"));
  // Tauri creates and descriptor-pins every profile resource root before the
  // desktop server accepts requests. Mirror that startup contract so the real
  // native initialization lock can run in this cold-module route fixture.
  for (const directory of ["config", "data/media", "models", "runtime"]) {
    fs.mkdirSync(path.join(tempRoot, directory), { recursive: true });
  }
  mocks.workspaceCommitFind.mockResolvedValue(null);
  mocks.workspaceCommitDelete.mockImplementation(async () => {
    events.push("restore-reconciled");
    return { count: 0 };
  });
  mocks.userFind.mockResolvedValue({ id: "00000000-0000-0000-0000-000000000000" });
  mocks.assetFindMany.mockResolvedValue([]);
  mocks.prepareImageFiles.mockImplementation(async (files: File[]) =>
    files.length > 0
      ? [{
          buffer: Buffer.from("image"),
          mimeType: "image/webp",
          width: 1,
          height: 1,
          sha256: "sha",
          byteSize: 5,
        }]
      : []);
  mocks.requireWritableCanvasSession.mockResolvedValue({ id: "session", projectId: null });
  const { resetLocalWorkspaceOwnerForTests } = await import(
    "@/lib/server/local-workspace-owner"
  );
  resetLocalWorkspaceOwnerForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("cold-module route startup barrier", () => {
  it("reconciles through the real owner module before upload acquires shared mutation", async () => {
    const { POST } = await import("@/app/api/assets/upload/route");
    const form = new FormData();
    form.set("file", new File(["image"], "image.webp", { type: "image/webp" }));
    const response = await POST(new NextRequest("http://localhost/api/assets/upload", {
      method: "POST",
      body: form,
    }));
    expect(response.status).toBe(200);
    expect(events).toEqual(["restore-reconciled", "route-mutation"]);
  });

  it("reconciles through the real owner module before image-route admission", async () => {
    const { POST } = await import("@/app/api/generate/images/route");
    const response = await POST(new NextRequest("http://localhost/api/generate/images", {
      method: "POST",
      body: new FormData(),
    }));
    expect(response.status).toBe(400);
    expect(events[0]).toBe("restore-reconciled");
  });

  it("reconciles through the real owner module before export-route admission", async () => {
    const { POST } = await import("@/app/api/canvas/sessions/[id]/export/route");
    const response = await POST(
      new NextRequest("http://localhost/api/canvas/sessions/session/export", {
        method: "POST",
        body: new FormData(),
      }),
      { params: Promise.resolve({ id: "session" }) },
    );
    expect(response.status).toBe(400);
    expect(events[0]).toBe("restore-reconciled");
  });
});
