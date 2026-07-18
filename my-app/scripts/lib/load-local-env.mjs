import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DESKTOP_SIGNING_ENV_KEYS = Object.freeze([
  "APPLE_SIGNING_IDENTITY",
  "APPLE_TEAM_ID",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_PASSWORD",
  "LUNERY_LOCAL_UNSIGNED_BUILD",
]);

export const DESKTOP_BUILD_ENV_KEYS = Object.freeze([
  ...DESKTOP_SIGNING_ENV_KEYS,
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_PATH",
  "DATABASE_URL",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "LUNERY_ACCEL",
  "LUNERY_DESKTOP_NODE_PATH",
]);

function trimEnvValue(raw) {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function parseEnvFile(file) {
  const values = new Map();
  const raw = readFileSync(file, "utf8");
  for (const sourceLine of raw.split(/\r?\n/)) {
    let line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values.set(key, trimEnvValue(line.slice(index + 1)));
  }
  return values;
}

export function loadLocalEnv({
  cwd = process.cwd(),
  files = [".env.local", ".env"],
  keys,
} = {}) {
  const allowedKeys = keys ? new Set(keys) : undefined;
  const loadedFiles = [];
  for (const name of files) {
    const file = path.join(cwd, name);
    if (!existsSync(file)) continue;
    for (const [key, value] of parseEnvFile(file)) {
      if (allowedKeys && !allowedKeys.has(key)) continue;
      if (process.env[key] === undefined) process.env[key] = value;
    }
    loadedFiles.push(file);
  }

  if (
    (!allowedKeys ||
      (allowedKeys.has("APPLE_PASSWORD") &&
        allowedKeys.has("APPLE_APP_SPECIFIC_PASSWORD"))) &&
    process.env.APPLE_PASSWORD === undefined &&
    process.env.APPLE_APP_SPECIFIC_PASSWORD !== undefined
  ) {
    process.env.APPLE_PASSWORD = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  }

  return loadedFiles;
}
