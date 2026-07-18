import { chmodSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export function findExtractedBinary(dir, binName) {
  for (const entry of readdirSync(dir)) {
    const current = join(dir, entry);
    const stat = statSync(current);
    if (stat.isDirectory()) {
      const found = findExtractedBinary(current, binName);
      if (found) return found;
    } else if (basename(current) === binName) {
      return current;
    }
  }
  return null;
}

export function installExtractedSidecar({
  workDir,
  binName,
  finalPath,
  engineDir,
  executable = true,
  siblingExtensions,
}) {
  const found = findExtractedBinary(workDir, binName);
  if (!found) {
    throw new Error(`${binName} not found in archive`);
  }

  copyFileSync(found, finalPath);
  if (executable) chmodSync(finalPath, 0o755);

  const libDir = join(found, "..");
  for (const entry of readdirSync(libDir)) {
    if (siblingExtensions.some((ext) => entry.endsWith(ext))) {
      copyFileSync(join(libDir, entry), join(engineDir, entry));
    }
  }

  return found;
}
