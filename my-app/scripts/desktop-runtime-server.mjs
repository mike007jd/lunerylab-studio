import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const appRoot = process.cwd();

class IncompatibleDesktopDatabaseError extends Error {}

function resolvePath(value, fallback) {
  if (!value?.trim()) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(appRoot, value);
}

function splitCommand(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1) {
    return [process.execPath, path.join(appRoot, "server.js")];
  }
  const command = argv.slice(separator + 1);
  if (command.length === 0) {
    throw new Error("Missing command after --");
  }
  return command;
}

async function applyMigrations(db, migrationsDir) {
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
    await db.query(
      `INSERT INTO "_prisma_migrations"
        ("id", "checksum", "migration_name", "started_at", "applied_steps_count")
       VALUES ($1, $2, $3, now(), 0)`,
      [migrationId, checksum, name],
    );
    try {
      await db.exec("BEGIN");
      await db.exec(migrationSql);
      await db.exec("COMMIT");
      await db.query(
        `UPDATE "_prisma_migrations"
            SET "finished_at" = now(), "applied_steps_count" = 1
          WHERE "id" = $1`,
        [migrationId],
      );
    } catch (error) {
      await db.exec("ROLLBACK").catch(() => undefined);
      await db.query(
        `UPDATE "_prisma_migrations"
            SET "logs" = $2
          WHERE "id" = $1`,
        [migrationId, error instanceof Error ? error.message : String(error)],
      );
      throw error;
    }
  }
}

function recoveryStamp(now = new Date()) {
  return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function archiveIncompatibleDatabase(dataRoot) {
  const recoveryRoot = path.join(path.dirname(dataRoot), "recovery");
  const recoveryPath = path.join(recoveryRoot, `pglite-${recoveryStamp()}`);
  await mkdir(recoveryRoot, { recursive: true });
  await rename(dataRoot, recoveryPath);
  await mkdir(dataRoot, { recursive: true });
  return recoveryPath;
}

async function openDesktopDatabase(dataRoot, migrationsDir) {
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

// Crash recovery: this desktop runtime is single-process, so any GenerationJob
// still marked RUNNING at boot is necessarily orphaned — the process that was
// driving it (its in-process `waitUntil` worker) died when the app last closed.
// Without this, those jobs would spin forever in the UI. We fail them once, at
// boot, before the Next server starts handling requests (so it can never catch a
// job legitimately started by the current process).
async function reconcileOrphanedJobs(db) {
  try {
    const result = await db.query(
      `UPDATE "GenerationJob"
          SET "status" = 'FAILED',
              "errorCode" = 'job_orphaned',
              "errorMessage" = 'This job was interrupted when the app last closed. Please start it again.',
              "completedAt" = NOW()
        WHERE "status" = 'RUNNING'`,
    );
    const affected = result?.affectedRows ?? 0;
    if (affected > 0) {
      console.log(`[desktop-runtime] Recovered ${affected} orphaned RUNNING job(s) from a prior session.`);
    }
  } catch (error) {
    // Non-fatal: a failed recovery sweep must not block app startup.
    console.error("[desktop-runtime] Orphaned-job recovery failed:", error);
  }
}

async function main() {
  const command = splitCommand(process.argv.slice(2));
  const dataRoot = resolvePath(
    process.env.LUNERY_PGLITE_DIR,
    path.join(os.homedir(), ".lunerylab", "studio", "data", "pglite"),
  );
  const migrationsDir = resolvePath(
    process.env.LUNERY_PRISMA_MIGRATIONS_DIR,
    path.join(appRoot, "prisma", "migrations"),
  );

  const db = await openDesktopDatabase(dataRoot, migrationsDir);
  await reconcileOrphanedJobs(db);

  const requestedPort = Number(process.env.LUNERY_PGLITE_PORT || "0");
  const socketServer = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port: Number.isFinite(requestedPort) ? requestedPort : 0,
    maxConnections: 12,
  });
  await socketServer.start();

  const [host, port] = socketServer.getServerConn().split(":");
  const databaseUrl = `postgresql://postgres:postgres@${host}:${port}/postgres?sslmode=disable&connection_limit=1&pool_timeout=20`;

  let shuttingDown = false;
  const child = spawn(command[0], command.slice(1), {
    cwd: appRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PGSSLMODE: "disable",
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
      CHECKPOINT_DISABLE: "1",
    },
  });

  async function shutdown(exitCode = 0, signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!child.killed) child.kill(signal || "SIGTERM");
    await socketServer.stop().catch(() => undefined);
    await db.close().catch(() => undefined);
    if (signal) process.kill(process.pid, signal);
    process.exit(exitCode);
  }

  const parentPid = Number(process.env.LUNERY_PARENT_PID || "0");
  if (Number.isInteger(parentPid) && parentPid > 1) {
    setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch (error) {
        if (error?.code !== "EPERM") void shutdown(0);
      }
    }, 2_000).unref();
  }

  process.on("SIGINT", () => shutdown(0, "SIGINT"));
  process.on("SIGTERM", () => shutdown(0, "SIGTERM"));

  child.on("error", async (error) => {
    console.error("[desktop-runtime] Could not start Studio server:", error);
    await shutdown(1);
  });

  child.on("exit", async (code, signal) => {
    await socketServer.stop().catch(() => undefined);
    await db.close().catch(() => undefined);
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error("[desktop-runtime] Startup failed:", error);
  process.exit(1);
});
