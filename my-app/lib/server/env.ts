function readPositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.floor(parsed);
}

export function getMaxUploadBytesPerFile(): number {
  return readPositiveIntEnv("ECOM_MAX_UPLOAD_BYTES_PER_FILE", 10 * 1024 * 1024);
}

export function getMaxStorageBytesPerUser(): number {
  return readPositiveIntEnv("ECOM_MAX_STORAGE_BYTES_PER_USER", 1024 * 1024 * 1024);
}
