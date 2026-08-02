/**
 * Crash/restart coverage for atomic PGlite migrations.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsModulePath = path.join(appRoot, "scripts/desktop-pglite-migrations.mjs");
const migrationsModuleHref = pathToFileURL(migrationsModulePath).href;

async function loadOpenDesktopDatabase(): Promise<
  (dataRoot: string, migrationsDir: string) => Promise<PGlite>
> {
  const mod = await import(migrationsModuleHref) as {
    openDesktopDatabase: (dataRoot: string, migrationsDir: string) => Promise<PGlite>;
  };
  return mod.openDesktopDatabase;
}

const FAILPOINTS = [
  "after-migration-insert",
  "during-migration-sql",
  "after-migration-sql",
] as const;

async function runFailpointChild(opts: {
  dataRoot: string;
  failpoint: string;
  proofPath: string;
  migrationsDir: string;
}): Promise<number> {
  const script = `
    import { applyMigrations } from ${JSON.stringify(migrationsModuleHref)};
    import { PGlite } from "@electric-sql/pglite";
    const db = new PGlite(${JSON.stringify(opts.dataRoot)});
    await db.waitReady;
    try {
      await applyMigrations(db, ${JSON.stringify(opts.migrationsDir)});
    } finally {
      await db.close().catch(() => undefined);
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LUNERY_TEST_PGLITE_MIGRATION_FAILPOINT: opts.failpoint,
      LUNERY_TEST_PGLITE_MIGRATION_FAILPOINT_PROOF: opts.proofPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return await new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => {
      if (signal === "SIGKILL") {
        resolve(137);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

describe("PGlite migration crash consistency", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanups.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("ignores migration failpoint environment outside test runtime", async () => {
    const script = `
      import { hitMigrationFailpoint } from ${JSON.stringify(migrationsModuleHref)};
      await hitMigrationFailpoint("after-migration-insert");
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: appRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        LUNERY_TEST_PGLITE_MIGRATION_FAILPOINT: "after-migration-insert",
      },
      stdio: "ignore",
    });
    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code, signal) => resolve(signal === "SIGKILL" ? 137 : (code ?? 1)));
    });
    expect(exitCode).toBe(0);
  });

  it("keeps migration record, schema SQL, and finished marker in one transaction", { timeout: 30_000 }, async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "pglite-migration-ok-"));
    cleanups.push(root);
    const dataRoot = path.join(root, "pglite");
    const migrationsDir = path.join(root, "migrations");
    await fs.mkdir(path.join(migrationsDir, "20990101000000_probe"), { recursive: true });
    await fs.writeFile(
      path.join(migrationsDir, "20990101000000_probe", "migration.sql"),
      `CREATE TABLE "lunery_migration_applied" ("id" TEXT PRIMARY KEY);`,
      "utf8",
    );

    const openDesktopDatabase = await loadOpenDesktopDatabase();
    const db = await openDesktopDatabase(dataRoot, migrationsDir);
    const tables = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE tablename = 'lunery_migration_applied'`,
    );
    const finished = await db.query<{ finished_at: string | null }>(
      `SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" = '20990101000000_probe'`,
    );
    await db.close();

    expect(tables.rows).toHaveLength(1);
    expect(finished.rows[0]?.finished_at).toBeTruthy();
  });

  for (const failpoint of FAILPOINTS) {
    it(`survives ${failpoint} crash and finishes migration on restart`, { timeout: 60_000 }, async () => {
      const root = await fs.mkdtemp(path.join(tmpdir(), `pglite-migration-${failpoint}-`));
      cleanups.push(root);
      const dataRoot = path.join(root, "pglite");
      const proofPath = path.join(root, "failpoint-proof");
      const migrationsDir = path.join(root, "migrations");
      const migrationName = "20990101000000_probe";
      await fs.mkdir(dataRoot, { recursive: true });
      await fs.mkdir(path.join(migrationsDir, migrationName), { recursive: true });
      await fs.writeFile(
        path.join(migrationsDir, migrationName, "migration.sql"),
        `CREATE TABLE "lunery_migration_applied" ("id" TEXT PRIMARY KEY);`,
        "utf8",
      );

      // Durable pre-migration business marker outside the failing transaction.
      const prep = new PGlite(dataRoot);
      await prep.waitReady;
      await prep.exec(
        `CREATE TABLE "lunery_migration_probe" ("id" TEXT PRIMARY KEY, "note" TEXT NOT NULL);
         INSERT INTO "lunery_migration_probe" ("id", "note") VALUES ('keep', 'present');`,
      );
      await prep.close();

      const exitCode = await runFailpointChild({
        dataRoot,
        failpoint,
        proofPath,
        migrationsDir,
      });
      expect(exitCode).toBe(137);
      await expect(fs.readFile(proofPath, "utf8")).resolves.toBe(failpoint);

      const openDesktopDatabase = await loadOpenDesktopDatabase();
      const restarted = await openDesktopDatabase(dataRoot, migrationsDir);
      const probe = await restarted.query<{ note: string }>(
        `SELECT "note" FROM "lunery_migration_probe" WHERE "id" = 'keep'`,
      );
      const applied = await restarted.query<{ finished_at: string | null }>(
        `SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" = $1`,
        [migrationName],
      );
      const table = await restarted.query(
        `SELECT tablename FROM pg_tables WHERE tablename = 'lunery_migration_applied'`,
      );
      const partialTable = await restarted.query(
        `SELECT tablename FROM pg_tables WHERE tablename = '_lunery_test_partial_migration'`,
      );
      await restarted.close();

      expect(probe.rows[0]?.note).toBe("present");
      expect(applied.rows).toHaveLength(1);
      expect(applied.rows[0]?.finished_at).toBeTruthy();
      expect(table.rows).toHaveLength(1);
      expect(partialTable.rows).toHaveLength(0);

      const recoveryDir = path.join(path.dirname(dataRoot), "recovery");
      await expect(fs.readdir(recoveryDir).catch(() => [])).resolves.toEqual([]);
    });
  }

  it("does not treat a finished migration as incompatible after after-migration-finished", { timeout: 60_000 }, async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "pglite-migration-finished-"));
    cleanups.push(root);
    const dataRoot = path.join(root, "pglite");
    const proofPath = path.join(root, "failpoint-proof");
    const migrationsDir = path.join(root, "migrations");
    const migrationName = "20990101000000_probe";
    await fs.mkdir(path.join(migrationsDir, migrationName), { recursive: true });
    await fs.writeFile(
      path.join(migrationsDir, migrationName, "migration.sql"),
      `CREATE TABLE "lunery_migration_applied" ("id" TEXT PRIMARY KEY);`,
      "utf8",
    );

    const exitCode = await runFailpointChild({
      dataRoot,
      failpoint: "after-migration-finished",
      proofPath,
      migrationsDir,
    });
    expect(exitCode).toBe(137);
    await expect(fs.readFile(proofPath, "utf8")).resolves.toBe("after-migration-finished");

    const openDesktopDatabase = await loadOpenDesktopDatabase();
    const restarted = await openDesktopDatabase(dataRoot, migrationsDir);
    const applied = await restarted.query<{ finished_at: string | null }>(
      `SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" = $1`,
      [migrationName],
    );
    await restarted.close();
    expect(applied.rows[0]?.finished_at).toBeTruthy();
    await expect(fs.readdir(path.join(path.dirname(dataRoot), "recovery")).catch(() => [])).resolves.toEqual([]);
  });
});
