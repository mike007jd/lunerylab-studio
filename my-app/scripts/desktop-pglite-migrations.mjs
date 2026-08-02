import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

export class IncompatibleDesktopDatabaseError extends Error {}

export async function hitMigrationFailpoint(name) {
  if (process.env.NODE_ENV !== "test") return;
  const requested = process.env.LUNERY_TEST_PGLITE_MIGRATION_FAILPOINT?.trim();
  if (!requested || requested !== name) return;
  const proofPath = process.env.LUNERY_TEST_PGLITE_MIGRATION_FAILPOINT_PROOF?.trim();
  if (proofPath) {
    await mkdir(path.dirname(proofPath), { recursive: true });
    await writeFile(proofPath, name, "utf8");
  }
  process.kill(process.pid, "SIGKILL");
  await new Promise(() => {});
}

/**
 * Apply pending Prisma SQL migrations atomically.
 * The migration row insert, schema SQL, and finished_at marker commit in one
 * PGlite transaction so a crash cannot leave schema applied without a finished
 * marker (or a finished marker without schema).
 */
export async function applyMigrations(db, migrationsDir) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT PRIMARY KEY,
      "checksum" TEXT NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    );
  `);

  const entries = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const name of entries) {
    const migrationSql = await readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");
    const checksum = createHash("sha256").update(migrationSql).digest("hex");

    const existing = await db.query(
      `SELECT "checksum", "finished_at", "logs", "rolled_back_at"
         FROM "_prisma_migrations"
        WHERE "migration_name" = $1
        ORDER BY "started_at" DESC
        LIMIT 1`,
      [name],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.rolled_back_at) {
        throw new IncompatibleDesktopDatabaseError(`Migration ${name} was rolled back.`);
      }
      if (!row.finished_at) {
        throw new IncompatibleDesktopDatabaseError(
          `Migration ${name} previously failed: ${row.logs || "no detail"}`,
        );
      }
      if (row.checksum !== checksum) {
        throw new IncompatibleDesktopDatabaseError(
          `Migration ${name} no longer matches the current desktop baseline.`,
        );
      }
      continue;
    }

    const migrationId = randomUUID();
    try {
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO "_prisma_migrations"
            ("id", "checksum", "migration_name", "started_at", "applied_steps_count")
           VALUES ($1, $2, $3, now(), 0)`,
          [migrationId, checksum, name],
        );
        await hitMigrationFailpoint("after-migration-insert");
        if (
          process.env.NODE_ENV === "test"
          && process.env.LUNERY_TEST_PGLITE_MIGRATION_FAILPOINT === "during-migration-sql"
        ) {
          // Execute real DDL inside the migration transaction before crashing.
          // The restart test proves a partially executed schema transaction is
          // rolled back together with its migration row.
          await tx.exec(`CREATE TABLE "_lunery_test_partial_migration" ("id" TEXT PRIMARY KEY);`);
          await hitMigrationFailpoint("during-migration-sql");
        }
        await tx.exec(migrationSql);
        await hitMigrationFailpoint("after-migration-sql");
        await tx.query(
          `UPDATE "_prisma_migrations"
              SET "finished_at" = now(), "applied_steps_count" = 1
            WHERE "id" = $1`,
          [migrationId],
        );
      });
      // Outside the transaction: proves a post-commit crash still leaves a
      // durable finished migration rather than an unfinished row.
      await hitMigrationFailpoint("after-migration-finished");
    } catch (error) {
      // A failed atomic transaction leaves no unfinished migration row. Record
      // the failure only when a row somehow remains (e.g. non-transactional SQL).
      await db.query(
        `UPDATE "_prisma_migrations"
            SET "logs" = $2
          WHERE "id" = $1 AND "finished_at" IS NULL`,
        [migrationId, error instanceof Error ? error.message : String(error)],
      ).catch(() => undefined);
      throw error;
    }
  }
}

export function recoveryStamp(now = new Date()) {
  return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export async function archiveIncompatibleDatabase(dataRoot) {
  const recoveryRoot = path.join(path.dirname(dataRoot), "recovery");
  const recoveryPath = path.join(recoveryRoot, `pglite-${recoveryStamp()}`);
  await mkdir(recoveryRoot, { recursive: true });
  await rename(dataRoot, recoveryPath);
  await mkdir(dataRoot, { recursive: true });
  return recoveryPath;
}

export async function openDesktopDatabase(dataRoot, migrationsDir) {
  await mkdir(dataRoot, { recursive: true });
  let db = new PGlite(dataRoot);
  try {
    await db.waitReady;
    await applyMigrations(db, migrationsDir);
    return db;
  } catch (error) {
    await db.close().catch(() => undefined);
    if (!(error instanceof IncompatibleDesktopDatabaseError)) throw error;

    const recoveryPath = await archiveIncompatibleDatabase(dataRoot);
    console.warn(
      `[desktop-runtime] Archived an incompatible prelaunch database at ${recoveryPath}. Starting from the current baseline.`,
    );

    db = new PGlite(dataRoot);
    await db.waitReady;
    await applyMigrations(db, migrationsDir);
    return db;
  }
}
