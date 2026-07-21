import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_PROFILE_NAME = "studio";

function assertAbsoluteEnvPath(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return trimmed;
}

function envPath(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) return null;
  const resolved = assertAbsoluteEnvPath(name, value);
  return resolved || null;
}

function userHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function luneryProfileRoot(): string {
  return envPath("LUNERY_HOME") ?? path.join(userHome(), ".lunerylab", DEFAULT_PROFILE_NAME);
}

export function luneryConfigDir(): string {
  return envPath("LUNERY_CONFIG_DIR") ?? path.join(luneryProfileRoot(), "config");
}

export function luneryDataDir(): string {
  return envPath("LUNERY_DATA_DIR") ?? path.join(luneryProfileRoot(), "data");
}

export function luneryModelsDir(): string {
  return envPath("LUNERY_MODELS_DIR") ?? path.join(luneryProfileRoot(), "models");
}

export function luneryLogDir(): string {
  return envPath("LUNERY_LOG_DIR") ?? path.join(luneryProfileRoot(), "logs");
}

export function luneryRuntimeDir(): string {
  return envPath("LUNERY_RUNTIME_DIR") ?? path.join(luneryProfileRoot(), "runtime");
}

export function luneryPgliteDir(): string {
  return envPath("LUNERY_PGLITE_DIR") ?? path.join(luneryDataDir(), "pglite");
}

export function luneryMediaDir(): string {
  return envPath("LUNERY_MEDIA_DIR") ?? path.join(luneryDataDir(), "media");
}
