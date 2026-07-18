import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  models: {} as Record<string, {
    findMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  }>,
  transaction: vi.fn(),
  isBlobStorage: vi.fn(),
  listStoredRelativePaths: vi.fn(),
  readStoredFile: vi.fn(),
}));

function makeModel() {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    createMany: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({}),
  };
}

vi.mock("@/lib/server/prisma", () => {
  const handler = {
    get(_t: unknown, key: string) {
      if (key === "$transaction") return mocks.transaction;
      mocks.models[key] ??= makeModel();
      return mocks.models[key];
    },
  };
  return { prisma: new Proxy({}, handler) };
});

vi.mock("@/lib/server/storage", () => ({
  isBlobStorage: mocks.isBlobStorage,
  listStoredRelativePaths: mocks.listStoredRelativePaths,
  readStoredFile: mocks.readStoredFile,
}));

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  CURRENT_SCHEMA_VERSION,
  exportWorkspaceBackup,
  restoreWorkspaceBackup,
  verifyBackupIntegrity,
  type WorkspaceBackup,
} from "@/lib/server/workspace-backup";
import { createHash } from "node:crypto";

let testRoot = "";

beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.models)) delete mocks.models[key];
  mocks.isBlobStorage.mockReturnValue(false);
  mocks.listStoredRelativePaths.mockResolvedValue([]);
  testRoot = await fs.mkdtemp(path.join(tmpdir(), "lunery-backup-test-"));
  vi.stubEnv("LUNERY_CONFIG_DIR", path.join(testRoot, "config"));
  vi.stubEnv("ECOM_STORAGE_DIR", path.join(testRoot, "media"));
  // $transaction passes a tx that proxies to the same per-model mocks.
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const txHandler = {
      get(_t: unknown, key: string) {
        mocks.models[key] ??= makeModel();
        return mocks.models[key];
      },
    };
    return fn(new Proxy({}, txHandler));
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(testRoot, { recursive: true, force: true });
});

const MODEL_NAMES = [
  "appState", "user", "userSettings", "project", "generationJob", "asset",
  "canvasSession", "canvasSnapshot", "agentTask", "canvasLayer", "agentMessage",
  "agentTaskStep", "referenceSet", "referenceSetAsset",
] as const;

function emptyData(): WorkspaceBackup["data"] {
  return Object.fromEntries(MODEL_NAMES.map((model) => [model, []]));
}

function refreshManifest(backup: WorkspaceBackup): WorkspaceBackup {
  backup.manifest.counts = Object.fromEntries(
    MODEL_NAMES.map((model) => [model, backup.data[model]?.length ?? 0]),
  );
  backup.manifest.dataSha256 = createHash("sha256")
    .update(Buffer.from(JSON.stringify(backup.data)))
    .digest("hex");
  backup.manifest.media = backup.media.map((entry) => {
    const bytes = Buffer.from(entry.base64, "base64");
    return { path: entry.path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  });
  backup.manifest.config = backup.config.map((entry) => {
    const bytes = Buffer.from(entry.base64, "base64");
    return { path: entry.path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  });
  return backup;
}

function goodBackup(): WorkspaceBackup {
  const bytes = Buffer.from([1, 2, 3, 4]);
  const sha = createHash("sha256").update(bytes).digest("hex");
  return refreshManifest({
    manifest: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      appVersion: "1.0.0",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: "2026-07-15T00:00:00.000Z",
      counts: {},
      dataSha256: "",
      media: [{ path: "generated/x.png", sha256: sha, bytes: 4 }],
      config: [],
      excluded: ["keychain-secrets"],
    },
    data: emptyData(),
    media: [{ path: "generated/x.png", base64: bytes.toString("base64") }],
    config: [],
  });
}

describe("exportWorkspaceBackup", () => {
  it("includes a manifest excluding keychain secrets and media checksums", async () => {
    const bytes = Buffer.from("hello");
    mocks.listStoredRelativePaths.mockResolvedValue(["generated/a.png"]);
    mocks.readStoredFile.mockResolvedValue({ file: bytes });

    const backup = await exportWorkspaceBackup("2026-07-15T00:00:00.000Z");

    expect(backup.manifest.format).toBe(BACKUP_FORMAT);
    expect(backup.manifest.excluded).toContain("keychain-secrets");
    expect(backup.manifest.excluded).toEqual(expect.arrayContaining(["models", "logs", "runtime-temp"]));
    expect(backup.manifest.dataSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(backup.manifest.media[0]).toMatchObject({
      path: "generated/a.png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: 5,
    });
    expect(backup.media[0]!.base64).toBe(bytes.toString("base64"));
  });
});

describe("verifyBackupIntegrity", () => {
  it("accepts a well-formed backup", () => {
    expect(() => verifyBackupIntegrity(goodBackup())).not.toThrow();
  });

  it("rejects a schema-version mismatch", () => {
    const b = goodBackup();
    b.manifest.schemaVersion = "99999999_other";
    expect(() => verifyBackupIntegrity(b)).toThrow(/schema/i);
  });

  it("rejects a corrupt media checksum (no partial restore)", () => {
    const b = goodBackup();
    b.media[0]!.base64 = Buffer.from([9, 9, 9]).toString("base64");
    expect(() => verifyBackupIntegrity(b)).toThrow(/checksum/i);
  });

  it("rejects tampered workspace rows and manifest counts", () => {
    const tampered = goodBackup();
    tampered.data.project!.push({ id: "p1" });
    expect(() => verifyBackupIntegrity(tampered)).toThrow(/data checksum/i);

    const wrongCount = goodBackup();
    wrongCount.manifest.counts.asset = 1;
    expect(() => verifyBackupIntegrity(wrongCount)).toThrow(/row count/i);
  });

  it("rejects extra, duplicate, or unsafe file payloads", () => {
    const extra = goodBackup();
    extra.media.push({ path: "generated/extra.png", base64: "AA==" });
    expect(() => verifyBackupIntegrity(extra)).toThrow(/absent from the manifest/i);

    const unsafe = goodBackup();
    unsafe.media[0]!.path = "../x.png";
    expect(() => verifyBackupIntegrity(unsafe)).toThrow(/invalid media path/i);
  });
});

describe("restoreWorkspaceBackup", () => {
  it("refuses without explicit confirmation", async () => {
    await expect(restoreWorkspaceBackup(goodBackup(), { confirm: false })).rejects.toMatchObject({
      code: "restore_not_confirmed",
    });
  });

  it("replaces the initialized workspace after explicit confirmation", async () => {
    await restoreWorkspaceBackup(goodBackup(), { confirm: true });
    for (const model of MODEL_NAMES) {
      expect(mocks.models[model]!.deleteMany).toHaveBeenCalledOnce();
    }
  });

  it("strips circular FKs on insert and back-fills them in a second pass", async () => {
    const b = goodBackup();
    b.data = {
      ...emptyData(),
      generationJob: [
        {
          id: "j1",
          agentTaskId: "t1",
          prompt: "2026-07-15T00:00:00.000Z product photo",
          createdAt: "2026-07-15T00:00:00.000Z",
        },
      ],
      asset: [
        { id: "a1", storagePath: "generated/x.png", mimeType: "image/png", agentTaskId: "t1", parentAssetId: null, createdAt: "2026-07-15T00:00:00.000Z" },
      ],
      agentTask: [{ id: "t1", createdAt: "2026-07-15T00:00:00.000Z", beforeSnapshotId: "s1" }],
      canvasSession: [{
        id: "s1",
        selectedAssetId: "a1",
        updatedAt: "2026-07-15T00:00:00.000Z",
      }],
    };
    refreshManifest(b);

    const result = await restoreWorkspaceBackup(b, { confirm: true });

    const asset = mocks.models.asset!;
    const agentTask = mocks.models.agentTask!;
    const generationJob = mocks.models.generationJob!;
    const canvasSession = mocks.models.canvasSession!;
    // asset inserted with agentTaskId nulled...
    const assetInsert = asset.createMany.mock.calls[0]![0].data[0]!;
    expect(assetInsert.agentTaskId).toBeNull();
    // ...and a Date revived from the ISO string.
    expect(assetInsert.createdAt).toBeInstanceOf(Date);
    // agentTask inserted with beforeSnapshotId nulled.
    const taskInsert = agentTask.createMany.mock.calls[0]![0].data[0]!;
    expect(taskInsert.beforeSnapshotId).toBeNull();
    // second pass restores both stripped FKs.
    expect(asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { agentTaskId: "t1" } });
    expect(agentTask.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { beforeSnapshotId: "s1" } });
    expect(generationJob.update).toHaveBeenCalledWith({ where: { id: "j1" }, data: { agentTaskId: "t1" } });
    expect(canvasSession.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { selectedAssetId: "a1", updatedAt: new Date("2026-07-15T00:00:00.000Z") },
    });
    expect(generationJob.createMany.mock.calls[0]![0].data[0]!.prompt).toBe(
      "2026-07-15T00:00:00.000Z product photo",
    );
    expect(result.mediaRestored).toBe(1);
  });

  it("removes every staged directory when preparation fails", async () => {
    const backup = goodBackup();
    backup.config = [
      { path: "collision", base64: Buffer.from("file").toString("base64") },
      { path: "collision/child.json", base64: Buffer.from("{}").toString("base64") },
    ];
    refreshManifest(backup);

    await expect(restoreWorkspaceBackup(backup, { confirm: true })).rejects.toMatchObject({ code: "EEXIST" });

    const entries = await fs.readdir(testRoot);
    expect(entries.some((entry) => entry.includes("restore-stage"))).toBe(false);
  });

  it("restores media and config only after full integrity validation", async () => {
    const backup = goodBackup();
    backup.config = [{ path: "provider-connections.json", base64: Buffer.from("{}").toString("base64") }];
    refreshManifest(backup);

    const result = await restoreWorkspaceBackup(backup, { confirm: true });

    expect(await fs.readFile(path.join(testRoot, "media/generated/x.png"))).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(await fs.readFile(path.join(testRoot, "config/provider-connections.json"), "utf8")).toBe("{}");
    expect(result.configRestored).toBe(1);
  });

  it("rolls local files back when the database transaction fails", async () => {
    await fs.mkdir(path.join(testRoot, "media/generated"), { recursive: true });
    await fs.mkdir(path.join(testRoot, "config"), { recursive: true });
    await fs.writeFile(path.join(testRoot, "media/generated/old.png"), "old");
    await fs.writeFile(path.join(testRoot, "config/current.json"), "current");
    mocks.transaction.mockRejectedValueOnce(new Error("db failed"));

    await expect(restoreWorkspaceBackup(goodBackup(), { confirm: true })).rejects.toThrow("db failed");

    expect(await fs.readFile(path.join(testRoot, "media/generated/old.png"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(testRoot, "config/current.json"), "utf8")).toBe("current");
    await expect(fs.access(path.join(testRoot, "media/generated/x.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
