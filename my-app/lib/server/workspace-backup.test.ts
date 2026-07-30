import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  models: {} as Record<string, {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  }>,
  transaction: vi.fn(),
  getStoredFileMetadata: vi.fn(),
  readStoredFile: vi.fn(),
}));

function makeModel() {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    createMany: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({}),
    upsert: vi.fn().mockResolvedValue({}),
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
  getStoredFileMetadata: mocks.getStoredFileMetadata,
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
import { assertRestorePayloadLimits } from "@/lib/server/workspace-restore-limits";
import { WORKSPACE_RESTORE_LIMITS } from "@/lib/workspace-backup-limits";
import {
  acquireWorkspaceExclusive,
  beginDetachedVideoWork,
  getWorkspaceOperationGateStateForTests,
  resetWorkspaceOperationGateForTests,
} from "@/lib/server/workspace-operation-gate";
import {
  buildExpectedRestoreSwaps,
  reconcileWorkspaceRestoreState,
  resetWorkspaceRestoreReconcileForTests,
  restoreJournalPath,
  writeRestoreJournal,
} from "@/lib/server/workspace-restore-journal";
import { createHash } from "node:crypto";

let testRoot = "";

beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.models)) delete mocks.models[key];
  resetWorkspaceOperationGateForTests();
  resetWorkspaceRestoreReconcileForTests();
  mocks.getStoredFileMetadata.mockResolvedValue({
    byteSize: 0,
    mimeType: "application/octet-stream",
  });
  testRoot = await fs.mkdtemp(path.join(tmpdir(), "lunery-backup-test-"));
  vi.stubEnv("LUNERY_CONFIG_DIR", path.join(testRoot, "config"));
  vi.stubEnv("LUNERY_MEDIA_DIR", path.join(testRoot, "media"));
  vi.stubEnv("LUNERY_DATA_DIR", path.join(testRoot, "data"));
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
  resetWorkspaceOperationGateForTests();
  resetWorkspaceRestoreReconcileForTests();
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
      appVersion: "0.2.0",
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

function seedAssetPaths(paths: string[]) {
  mocks.models.asset = makeModel();
  mocks.models.asset.findMany.mockResolvedValue(
    paths.map((storagePath, index) => ({ id: `asset-${index}`, storagePath })),
  );
}

describe("exportWorkspaceBackup", () => {
  it("includes a manifest excluding keychain secrets and media checksums", async () => {
    const bytes = Buffer.from("hello");
    seedAssetPaths(["generated/a.png", "uploads/ref.jpg"]);
    mocks.getStoredFileMetadata.mockImplementation(async (storagePath: string) => ({
      byteSize: storagePath === "generated/a.png" ? 5 : 3,
      mimeType: "image/png",
    }));
    mocks.readStoredFile.mockImplementation(async (storagePath: string) => ({
      file: storagePath === "generated/a.png" ? bytes : Buffer.from("ref"),
    }));

    const backup = await exportWorkspaceBackup("2026-07-15T00:00:00.000Z");

    expect(backup.manifest.format).toBe(BACKUP_FORMAT);
    expect(backup.manifest.appVersion).toBe("0.2.1");
    expect(backup.manifest.version).toBe(BACKUP_VERSION);
    expect(backup.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(backup.manifest.excluded).toContain("keychain-secrets");
    expect(backup.manifest.excluded).toEqual(
      expect.arrayContaining(["models", "logs", "runtime-temp", "restore-journal"]),
    );
    expect(backup.data).not.toHaveProperty("workspaceRestoreCommit");
    expect(mocks.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "RepeatableRead" }),
    );
    expect(backup.manifest.dataSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(backup.manifest.media).toEqual([
      {
        path: "generated/a.png",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: 5,
      },
      {
        path: "uploads/ref.jpg",
        sha256: createHash("sha256").update(Buffer.from("ref")).digest("hex"),
        bytes: 3,
      },
    ]);
    expect(backup.media.map((entry) => entry.path)).toEqual(["generated/a.png", "uploads/ref.jpg"]);
    expect(mocks.readStoredFile).toHaveBeenCalledTimes(2);
    expect(() => assertRestorePayloadLimits(backup)).not.toThrow();
    // Compact wire form (no pretty-print) is what the client download/restore path uses.
    expect(
      Buffer.byteLength(JSON.stringify({ backup, confirm: true })),
    ).toBeLessThanOrEqual(WORKSPACE_RESTORE_LIMITS.maxEncodedBytes);
    expect(JSON.stringify(backup).includes("\n")).toBe(false);
  });

  it("exports only Asset.storagePath values from the transaction snapshot", async () => {
    const tracked = Buffer.from("track");
    seedAssetPaths(["generated/tracked.png"]);
    mocks.getStoredFileMetadata.mockResolvedValue({
      byteSize: tracked.byteLength,
      mimeType: "image/png",
    });
    mocks.readStoredFile.mockResolvedValue({ file: tracked });
    await fs.mkdir(path.join(testRoot, "media/generated"), { recursive: true });
    await fs.writeFile(path.join(testRoot, "media/generated/orphan.png"), "orphan");

    const backup = await exportWorkspaceBackup("2026-07-15T00:00:00.000Z");

    expect(backup.media.map((entry) => entry.path)).toEqual(["generated/tracked.png"]);
    expect(backup.media.map((entry) => entry.path)).not.toContain("generated/orphan.png");
    expect(mocks.readStoredFile).toHaveBeenCalledWith("generated/tracked.png");
  });

  it("rejects one oversized file from metadata before reading bytes", async () => {
    seedAssetPaths(["generated/huge.mp4"]);
    mocks.getStoredFileMetadata.mockResolvedValue({
      byteSize: WORKSPACE_RESTORE_LIMITS.maxPerFileDecodedBytes + 1,
      mimeType: "video/mp4",
    });

    await expect(
      exportWorkspaceBackup("2026-07-15T00:00:00.000Z"),
    ).rejects.toMatchObject({ status: 413, code: "backup_too_large" });
    expect(mocks.readStoredFile).not.toHaveBeenCalled();
  });

  it("rejects aggregate media overflow from metadata before reading bytes", async () => {
    seedAssetPaths(["generated/a.mp4", "generated/b.mp4"]);
    mocks.getStoredFileMetadata.mockResolvedValue({
      byteSize: 50 * 1024 * 1024,
      mimeType: "video/mp4",
    });

    await expect(
      exportWorkspaceBackup("2026-07-15T00:00:00.000Z"),
    ).rejects.toMatchObject({ status: 413, code: "backup_too_large" });
    expect(mocks.readStoredFile).not.toHaveBeenCalled();
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
    await expect(fs.access(restoreJournalPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the journal when reconciliation itself fails after an in-process error", async () => {
    await fs.mkdir(path.join(testRoot, "media/generated"), { recursive: true });
    await fs.mkdir(path.join(testRoot, "config"), { recursive: true });
    await fs.writeFile(path.join(testRoot, "media/generated/old.png"), "old");
    await fs.writeFile(path.join(testRoot, "config/current.json"), "current");
    mocks.transaction.mockRejectedValueOnce(new Error("db failed"));
    mocks.models.workspaceRestoreCommit = makeModel();
    mocks.models.workspaceRestoreCommit.findUnique.mockRejectedValueOnce(new Error("marker read failed"));

    await expect(restoreWorkspaceBackup(goodBackup(), { confirm: true })).rejects.toMatchObject({
      code: "restore_rollback_failed",
    });
    await expect(fs.access(restoreJournalPath())).resolves.toBeUndefined();
  });

  it("writes the restore commit marker inside the replacement transaction", async () => {
    await restoreWorkspaceBackup(goodBackup(), { confirm: true });
    expect(mocks.models.workspaceRestoreCommit!.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ token: expect.any(String) }),
        update: expect.objectContaining({ token: expect.any(String) }),
      }),
    );
    expect(mocks.models.workspaceRestoreCommit!.deleteMany).toHaveBeenCalled();
    await expect(fs.access(restoreJournalPath())).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("workspace operation gate", () => {
  it("rejects backup while a detached video job holds admission", async () => {
    const admission = beginDetachedVideoWork();
    await expect(exportWorkspaceBackup("2026-07-15T00:00:00.000Z")).rejects.toMatchObject({
      status: 409,
      code: "workspace_busy",
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    admission.release();
  });

  it("rejects restore while a detached video job holds admission", async () => {
    const admission = beginDetachedVideoWork();
    await expect(restoreWorkspaceBackup(goodBackup(), { confirm: true })).rejects.toMatchObject({
      status: 409,
      code: "workspace_busy",
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    admission.release();
  });

  it("rejects new video admission while backup owns exclusivity", async () => {
    const release = acquireWorkspaceExclusive("backup");
    expect(() => beginDetachedVideoWork()).toThrow(
      expect.objectContaining({ status: 409, code: "workspace_busy" }),
    );
    expect(getWorkspaceOperationGateStateForTests()).toEqual({
      exclusive: "backup",
      activeVideoCount: 0,
    });
    release();
  });

  it("releases exclusive ownership after export failure", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("export failed"));
    await expect(exportWorkspaceBackup("2026-07-15T00:00:00.000Z")).rejects.toThrow("export failed");
    expect(getWorkspaceOperationGateStateForTests()).toEqual({
      exclusive: null,
      activeVideoCount: 0,
    });
    await expect(exportWorkspaceBackup("2026-07-15T00:00:00.000Z")).resolves.toBeTruthy();
  });
});

describe("restore crash reconciliation", () => {
  async function seedPromotedTrees(token: string) {
    const expected = buildExpectedRestoreSwaps(token);
    const media = expected[0]!;
    const config = expected[1]!;
    await fs.mkdir(path.join(media.root, "generated"), { recursive: true });
    await fs.mkdir(config.root, { recursive: true });
    await fs.mkdir(path.join(media.previous, "generated"), { recursive: true });
    await fs.mkdir(config.previous, { recursive: true });
    await fs.writeFile(path.join(media.root, "generated/new.png"), "new-media");
    await fs.writeFile(path.join(config.root, "new.json"), "new-config");
    await fs.writeFile(path.join(media.previous, "generated/old.png"), "old-media");
    await fs.writeFile(path.join(config.previous, "old.json"), "old-config");
    return {
      swaps: [
        { ...media, previousExisted: true },
        { ...config, previousExisted: true },
      ],
    };
  }

  it("rolls filesystem roots back when the journal exists without a commit marker", async () => {
    const token = "crash-uncommitted";
    const { swaps } = await seedPromotedTrees(token);
    await writeRestoreJournal({
      format: "lunery-workspace-restore-journal",
      version: 1,
      token,
      swaps,
    });
    mocks.models.workspaceRestoreCommit = makeModel();
    mocks.models.workspaceRestoreCommit.findUnique.mockResolvedValue(null);

    await reconcileWorkspaceRestoreState();

    expect(await fs.readFile(path.join(testRoot, "media/generated/old.png"), "utf8")).toBe("old-media");
    expect(await fs.readFile(path.join(testRoot, "config/old.json"), "utf8")).toBe("old-config");
    await expect(fs.access(path.join(testRoot, "media/generated/new.png"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(restoreJournalPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.models.workspaceRestoreCommit.deleteMany).toHaveBeenCalled();

    // Idempotent across a second restart with no residue.
    await reconcileWorkspaceRestoreState();
    expect(await fs.readFile(path.join(testRoot, "media/generated/old.png"), "utf8")).toBe("old-media");
  });

  it("keeps new roots and finishes cleanup when the commit marker matches the journal", async () => {
    const token = "crash-committed";
    const { swaps } = await seedPromotedTrees(token);
    await writeRestoreJournal({
      format: "lunery-workspace-restore-journal",
      version: 1,
      token,
      swaps,
    });
    mocks.models.workspaceRestoreCommit = makeModel();
    mocks.models.workspaceRestoreCommit.findUnique.mockResolvedValue({ token });

    await reconcileWorkspaceRestoreState();

    expect(await fs.readFile(path.join(testRoot, "media/generated/new.png"), "utf8")).toBe("new-media");
    expect(await fs.readFile(path.join(testRoot, "config/new.json"), "utf8")).toBe("new-config");
    await expect(fs.access(swaps[0]!.previous)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(restoreJournalPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.models.workspaceRestoreCommit.deleteMany).toHaveBeenCalled();
  });

  it("fails closed and preserves recovery material when a committed root is missing", async () => {
    const token = "crash-missing-root";
    const { swaps } = await seedPromotedTrees(token);
    await writeRestoreJournal({
      format: "lunery-workspace-restore-journal",
      version: 1,
      token,
      swaps,
    });
    await fs.rm(swaps[1]!.root, { recursive: true, force: true });
    mocks.models.workspaceRestoreCommit = makeModel();
    mocks.models.workspaceRestoreCommit.findUnique.mockResolvedValue({ token });

    await expect(reconcileWorkspaceRestoreState()).rejects.toThrow(
      "Committed workspace restore root is missing: config",
    );

    await expect(fs.access(restoreJournalPath())).resolves.toBeUndefined();
    await expect(fs.access(swaps[0]!.previous)).resolves.toBeUndefined();
    await expect(fs.access(swaps[1]!.previous)).resolves.toBeUndefined();
    expect(mocks.models.workspaceRestoreCommit.deleteMany).not.toHaveBeenCalled();
  });

  it("preserves untouched old config when media was promoted but config was not", async () => {
    const token = "crash-media-only";
    const expected = buildExpectedRestoreSwaps(token);
    const media = expected[0]!;
    const config = expected[1]!;

    await fs.mkdir(path.join(media.root, "generated"), { recursive: true });
    await fs.mkdir(path.join(media.previous, "generated"), { recursive: true });
    await fs.mkdir(config.root, { recursive: true });
    await fs.mkdir(path.join(config.staged, "keep"), { recursive: true });
    await fs.writeFile(path.join(media.root, "generated/new.png"), "new-media");
    await fs.writeFile(path.join(media.previous, "generated/old.png"), "old-media");
    await fs.writeFile(path.join(config.root, "old.json"), "old-config");
    await fs.writeFile(path.join(config.staged, "new.json"), "new-config");

    await writeRestoreJournal({
      format: "lunery-workspace-restore-journal",
      version: 1,
      token,
      swaps: [
        { ...media, previousExisted: true },
        { ...config, previousExisted: true },
      ],
    });
    mocks.models.workspaceRestoreCommit = makeModel();
    mocks.models.workspaceRestoreCommit.findUnique.mockResolvedValue(null);

    await reconcileWorkspaceRestoreState();

    expect(await fs.readFile(path.join(testRoot, "media/generated/old.png"), "utf8")).toBe("old-media");
    expect(await fs.readFile(path.join(testRoot, "config/old.json"), "utf8")).toBe("old-config");
    await expect(fs.access(config.staged)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(restoreJournalPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on hostile journal paths without deleting workspace roots", async () => {
    await fs.mkdir(path.join(testRoot, "media/generated"), { recursive: true });
    await fs.mkdir(path.join(testRoot, "config"), { recursive: true });
    await fs.writeFile(path.join(testRoot, "media/generated/keep.png"), "keep-media");
    await fs.writeFile(path.join(testRoot, "config/keep.json"), "keep-config");
    await fs.mkdir(path.join(testRoot, "data/recovery"), { recursive: true });
    await fs.writeFile(
      restoreJournalPath(),
      `${JSON.stringify({
        format: "lunery-workspace-restore-journal",
        version: 1,
        token: "hostile-token",
        swaps: [
          {
            root: "/tmp/evil-media",
            staged: "/tmp/evil-media-stage",
            previous: "/tmp/evil-media-previous",
            previousExisted: true,
          },
          {
            root: "/tmp/evil-config",
            staged: "/tmp/evil-config-stage",
            previous: "/tmp/evil-config-previous",
            previousExisted: true,
          },
        ],
      })}\n`,
    );

    await expect(reconcileWorkspaceRestoreState()).rejects.toThrow(/hostile|Corrupt/i);
    expect(await fs.readFile(path.join(testRoot, "media/generated/keep.png"), "utf8")).toBe("keep-media");
    expect(await fs.readFile(path.join(testRoot, "config/keep.json"), "utf8")).toBe("keep-config");
    await expect(fs.access(restoreJournalPath())).resolves.toBeUndefined();
  });
});
