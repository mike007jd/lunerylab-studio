import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { openDesktopDatabase } from "./desktop-pglite-migrations.mjs";

const appRoot = process.cwd();

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

// Crash recovery: this desktop runtime is single-process, so any GenerationJob
// still marked RUNNING at boot is necessarily orphaned — the process that was
// driving it (its in-process background worker) died when the app last closed.
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
