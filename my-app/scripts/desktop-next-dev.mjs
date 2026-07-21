import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, delimiter, join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(scriptDir, "..");
const runtimeWrapper = join(scriptDir, "desktop-runtime-server.mjs");
const nodeBinDir = dirname(process.execPath);
const localBinDir = join(appRoot, "node_modules", ".bin");
const pathWithCurrentNode = [nodeBinDir, localBinDir, process.env.PATH].filter(Boolean).join(delimiter);

function absoluteEnvPath(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!path.isAbsolute(raw)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return raw;
}

const profileRoot = absoluteEnvPath("LUNERY_HOME", join(os.homedir(), ".lunerylab", "studio-dev"));
const configDir = absoluteEnvPath("LUNERY_CONFIG_DIR", join(profileRoot, "config"));
const dataDir = absoluteEnvPath("LUNERY_DATA_DIR", join(profileRoot, "data"));
const modelsDir = absoluteEnvPath("LUNERY_MODELS_DIR", join(profileRoot, "models"));
const logDir = absoluteEnvPath("LUNERY_LOG_DIR", join(profileRoot, "logs"));
const runtimeDir = absoluteEnvPath("LUNERY_RUNTIME_DIR", join(profileRoot, "runtime"));
const pgliteDir = absoluteEnvPath("LUNERY_PGLITE_DIR", join(dataDir, "pglite"));
const mediaDir = absoluteEnvPath("LUNERY_MEDIA_DIR", join(dataDir, "media"));

await Promise.all([
  mkdir(configDir, { recursive: true }),
  mkdir(pgliteDir, { recursive: true }),
  mkdir(mediaDir, { recursive: true }),
  mkdir(modelsDir, { recursive: true }),
  mkdir(logDir, { recursive: true }),
  mkdir(runtimeDir, { recursive: true }),
]);
const child = spawn(
  process.execPath,
  [
    runtimeWrapper,
    "--",
    process.execPath,
    nextBin,
    "dev",
    "--webpack",
    "--hostname",
    "127.0.0.1",
    "--port",
    process.env.PORT || "3000",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: pathWithCurrentNode,
      LUNERY_DESKTOP: "1",
      LUNERY_HOME: profileRoot,
      LUNERY_CONFIG_DIR: configDir,
      LUNERY_DATA_DIR: dataDir,
      LUNERY_MODELS_DIR: modelsDir,
      LUNERY_LOG_DIR: logDir,
      LUNERY_RUNTIME_DIR: runtimeDir,
      LUNERY_PGLITE_DIR: pgliteDir,
      LUNERY_MEDIA_DIR: mediaDir,
      LUNERY_PRISMA_MIGRATIONS_DIR: join(appRoot, "prisma", "migrations"),
    },
  },
);

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};

process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
