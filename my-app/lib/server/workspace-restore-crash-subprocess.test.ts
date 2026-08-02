/**
 * Real process-termination coverage for workspace restore promotion boundaries.
 *
 * Parent cases spawn a child vitest process that runs production
 * `restoreWorkspaceBackup` against an isolated profile, SIGKILLs itself at a
 * named boundary, then the parent runs production reconciliation and asserts
 * deterministic old+old or new+new with no recovery residue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));

const COMMIT_MARKER_FILE = "commit-marker-token";
const BOUNDARY_PROOF_FILE = "boundary-hit";

function markerFilePath(): string {
  const dataDir = process.env.LUNERY_DATA_DIR;
  if (!dataDir) throw new Error("LUNERY_DATA_DIR required");
  return path.join(dataDir, "recovery", COMMIT_MARKER_FILE);
}

function boundaryProofPath(): string {
  const dataDir = process.env.LUNERY_DATA_DIR;
  if (!dataDir) throw new Error("LUNERY_DATA_DIR required");
  return path.join(dataDir, "recovery", BOUNDARY_PROOF_FILE);
}

async function persistBoundaryProof(boundary: RestorePromotionBoundary): Promise<void> {
  const target = boundaryProofPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const handle = await fs.open(target, "w");
  try {
    await handle.writeFile(boundary, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await fs.open(path.dirname(target), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

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

function installDurableCommitMarkerMocks() {
  mocks.models.workspaceRestoreCommit = makeModel();
  mocks.models.workspaceRestoreCommit.findUnique.mockImplementation(async () => {
    try {
      const token = await fs.readFile(markerFilePath(), "utf8");
      return { token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
      throw error;
    }
  });
  mocks.models.workspaceRestoreCommit.upsert.mockImplementation(
    async (args: { create: { token: string } }) => {
      await fs.mkdir(path.dirname(markerFilePath()), { recursive: true });
      const handle = await fs.open(markerFilePath(), "w");
      try {
        await handle.writeFile(args.create.token, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { id: "singleton", token: args.create.token };
    },
  );
  mocks.models.workspaceRestoreCommit.deleteMany.mockImplementation(async () => {
    try {
      await fs.unlink(markerFilePath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { count: 0 };
      throw error;
    }
    return { count: 1 };
  });
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
  getStoredFileMetadata: vi.fn(),
  readStoredFile: vi.fn(),
}));

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  CURRENT_SCHEMA_VERSION,
  restoreWorkspaceBackup,
  setRestorePromotionHookForTests,
  type RestorePromotionBoundary,
  type WorkspaceBackup,
} from "@/lib/server/workspace-backup";
import {
  reconcileWorkspaceRestoreState,
  resetWorkspaceRestoreReconcileForTests,
  restoreJournalPath,
} from "@/lib/server/workspace-restore-journal";
import { resetWorkspaceOperationGateForTests } from "@/lib/server/workspace-operation-gate";

const isCrashChild = process.env.LUNERY_RESTORE_CRASH_CHILD === "1";
const THIS_FILE = fileURLToPath(import.meta.url);

const MODEL_NAMES = [
  "appState", "user", "userSettings", "project", "generationJob", "asset",
  "canvasSession", "canvasSnapshot", "agentTask", "canvasLayer", "agentMessage",
  "agentTaskStep", "referenceSet", "referenceSetAsset",
] as const;

function emptyData(): WorkspaceBackup["data"] {
  return Object.fromEntries(MODEL_NAMES.map((model) => [model, []]));
}

function crashBackup(): WorkspaceBackup {
  const mediaBytes = Buffer.from("new-media-bytes");
  const configBytes = Buffer.from('{"mode":"new"}');
  const mediaSha = createHash("sha256").update(mediaBytes).digest("hex");
  const configSha = createHash("sha256").update(configBytes).digest("hex");
  const data = emptyData();
  const dataSha256 = createHash("sha256").update(Buffer.from(JSON.stringify(data))).digest("hex");
  return {
    manifest: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      appVersion: "0.2.1",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: "2026-07-15T00:00:00.000Z",
      counts: Object.fromEntries(MODEL_NAMES.map((model) => [model, 0])),
      dataSha256,
      media: [{ path: "generated/restored.png", sha256: mediaSha, bytes: mediaBytes.byteLength }],
      config: [{ path: "settings.json", sha256: configSha, bytes: configBytes.byteLength }],
      excluded: ["keychain-secrets", "models", "logs", "runtime-temp", "restore-journal"],
    },
    data,
    media: [{ path: "generated/restored.png", base64: mediaBytes.toString("base64") }],
    config: [{ path: "settings.json", base64: configBytes.toString("base64") }],
  };
}

async function seedOldWorkspace(profileRoot: string) {
  const media = path.join(profileRoot, "media");
  const config = path.join(profileRoot, "config");
  await fs.mkdir(path.join(media, "generated"), { recursive: true });
  await fs.mkdir(config, { recursive: true });
  await fs.writeFile(path.join(media, "generated/old.png"), "old-media");
  await fs.writeFile(path.join(config, "settings.json"), '{"mode":"old"}');
}

async function listRecoveryResidue(profileRoot: string): Promise<string[]> {
  const entries = await fs.readdir(profileRoot);
  const residue = entries.filter(
    (entry) =>
      entry.includes("restore-stage") ||
      entry.includes("restore-previous") ||
      entry.startsWith(".media.") ||
      entry.startsWith(".config."),
  );
  try {
    await fs.access(path.join(profileRoot, "data/recovery/workspace-restore.json"));
    residue.push("workspace-restore.json");
  } catch {
    // absent is success
  }
  try {
    await fs.access(path.join(profileRoot, "data/recovery", COMMIT_MARKER_FILE));
    residue.push(COMMIT_MARKER_FILE);
  } catch {
    // absent is success
  }
  return residue;
}

// JavaScript can truthfully observe staging and the native pair operation only
// before/after its bridge call. Native media/config partial-rename crash phases
// are covered by descriptor-level Rust rollback seam tests.
const UNCOMMITTED_BOUNDARIES: RestorePromotionBoundary[] = [
  "after-journal-before-staging",
  "after-media-stage-files",
  "after-media-stage-fsync",
  "after-config-stage-files",
  "after-config-stage-fsync",
  "before-native-root-promotion",
  "after-native-root-promotion",
];

(isCrashChild ? describe : describe.skip)("restore crash child", () => {
  it("runs production restore until the requested kill boundary", async () => {
    const profileRoot = process.env.LUNERY_RESTORE_CRASH_PROFILE;
    const boundary = process.env.LUNERY_RESTORE_KILL_BOUNDARY as RestorePromotionBoundary | undefined;
    if (!profileRoot || !boundary) {
      throw new Error("Child requires LUNERY_RESTORE_CRASH_PROFILE and LUNERY_RESTORE_KILL_BOUNDARY");
    }

    process.env.LUNERY_CONFIG_DIR = path.join(profileRoot, "config");
    process.env.LUNERY_MEDIA_DIR = path.join(profileRoot, "media");
    process.env.LUNERY_DATA_DIR = path.join(profileRoot, "data");

    for (const key of Object.keys(mocks.models)) delete mocks.models[key];
    resetWorkspaceOperationGateForTests();
    resetWorkspaceRestoreReconcileForTests();
    installDurableCommitMarkerMocks();
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const txHandler = {
        get(_t: unknown, key: string) {
          if (key === "workspaceRestoreCommit") {
            if (!mocks.models.workspaceRestoreCommit) installDurableCommitMarkerMocks();
            return mocks.models.workspaceRestoreCommit;
          }
          mocks.models[key] ??= makeModel();
          return mocks.models[key];
        },
      };
      return fn(new Proxy({}, txHandler));
    });

    setRestorePromotionHookForTests(async (hit) => {
      if (hit === boundary) {
        // A durable proof prevents the parent from accepting an unrelated
        // Vitest/bootstrap failure as successful boundary coverage.
        await persistBoundaryProof(boundary);
        process.kill(process.pid, "SIGKILL");
        await new Promise(() => undefined);
      }
    });

    try {
      await restoreWorkspaceBackup(crashBackup(), { confirm: true });
    } finally {
      setRestorePromotionHookForTests(null);
    }

    throw new Error(`Restore completed without SIGKILL at boundary ${boundary}`);
  }, 60_000);
});

(!isCrashChild ? describe : describe.skip)("restore crash subprocess", () => {
  let profileRoot = "";

  beforeEach(async () => {
    for (const key of Object.keys(mocks.models)) delete mocks.models[key];
    resetWorkspaceOperationGateForTests();
    resetWorkspaceRestoreReconcileForTests();
    profileRoot = await fs.mkdtemp(path.join(tmpdir(), "lunery-restore-crash-"));
    process.env.LUNERY_CONFIG_DIR = path.join(profileRoot, "config");
    process.env.LUNERY_MEDIA_DIR = path.join(profileRoot, "media");
    process.env.LUNERY_DATA_DIR = path.join(profileRoot, "data");
    await seedOldWorkspace(profileRoot);
    installDurableCommitMarkerMocks();
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
    setRestorePromotionHookForTests(null);
    resetWorkspaceOperationGateForTests();
    resetWorkspaceRestoreReconcileForTests();
    delete process.env.LUNERY_CONFIG_DIR;
    delete process.env.LUNERY_MEDIA_DIR;
    delete process.env.LUNERY_DATA_DIR;
    await fs.rm(profileRoot, { recursive: true, force: true });
  });

  async function runChildUntilKilled(boundary: RestorePromotionBoundary): Promise<void> {
    const child = spawn(
      process.execPath,
      [
        path.resolve(process.cwd(), "node_modules/vitest/vitest.mjs"),
        "run",
        THIS_FILE,
        "-t",
        "runs production restore until the requested kill boundary",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LUNERY_RESTORE_CRASH_CHILD: "1",
          LUNERY_RESTORE_CRASH_PROFILE: profileRoot,
          LUNERY_RESTORE_KILL_BOUNDARY: boundary,
          LUNERY_CONFIG_DIR: path.join(profileRoot, "config"),
          LUNERY_MEDIA_DIR: path.join(profileRoot, "media"),
          LUNERY_DATA_DIR: path.join(profileRoot, "data"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on("close", (code, signal) => resolve({ code, signal }));
      },
    );

    const killed =
      result.signal === "SIGKILL" ||
      result.code === 137 ||
      // vitest may surface the worker death as a non-zero exit without signal
      (result.code !== 0 && result.code !== null);
    let provenBoundary: string | null = null;
    try {
      provenBoundary = await fs.readFile(boundaryProofPath(), "utf8");
    } catch {
      // Report the original child output below.
    }
    if (!killed || provenBoundary !== boundary) {
      throw new Error(
        `Expected child SIGKILL at ${boundary}, got code=${result.code} signal=${result.signal} proof=${provenBoundary ?? "missing"}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    await fs.unlink(boundaryProofPath());
  }

  it.each(UNCOMMITTED_BOUNDARIES)(
    "recovers old+old after SIGKILL at %s",
    async (boundary) => {
      await runChildUntilKilled(boundary);
      await expect(fs.access(restoreJournalPath())).resolves.toBeUndefined();

      await reconcileWorkspaceRestoreState();

      expect(await fs.readFile(path.join(profileRoot, "media/generated/old.png"), "utf8")).toBe(
        "old-media",
      );
      expect(await fs.readFile(path.join(profileRoot, "config/settings.json"), "utf8")).toBe(
        '{"mode":"old"}',
      );
      await expect(
        fs.access(path.join(profileRoot, "media/generated/restored.png")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await listRecoveryResidue(profileRoot)).toEqual([]);

      // Second restart is a no-op with the same deterministic state.
      await reconcileWorkspaceRestoreState();
      expect(await fs.readFile(path.join(profileRoot, "config/settings.json"), "utf8")).toBe(
        '{"mode":"old"}',
      );
      expect(await listRecoveryResidue(profileRoot)).toEqual([]);
    },
    120_000,
  );

  it(
    "keeps new+new after SIGKILL following commit-marker persistence",
    async () => {
      await runChildUntilKilled("after-commit-marker");
      await expect(fs.access(restoreJournalPath())).resolves.toBeUndefined();
      await expect(fs.access(markerFilePath())).resolves.toBeUndefined();

      await reconcileWorkspaceRestoreState();

      expect(
        await fs.readFile(path.join(profileRoot, "media/generated/restored.png"), "utf8"),
      ).toBe("new-media-bytes");
      expect(await fs.readFile(path.join(profileRoot, "config/settings.json"), "utf8")).toBe(
        '{"mode":"new"}',
      );
      await expect(
        fs.access(path.join(profileRoot, "media/generated/old.png")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await listRecoveryResidue(profileRoot)).toEqual([]);
    },
    120_000,
  );
});
