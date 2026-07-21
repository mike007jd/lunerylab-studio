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
  return readPositiveIntEnv("LUNERY_MAX_UPLOAD_BYTES_PER_FILE", 10 * 1024 * 1024);
}
