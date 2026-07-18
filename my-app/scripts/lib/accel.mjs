// Shared accelerator-variant helpers for the Windows sidecar fetch scripts
// (fetch-llama-server / fetch-sd-server). macOS arm64 is always Metal and
// never calls these.
import { mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { downloadFile, resolveGitHubReleaseAsset, verifySha256File } from "./integrity.mjs";

/**
 * Resolve the build-time accelerator. Unknown/empty → "cpu" (the historical
 * hardcoded behavior — the regression red line).
 */
export function resolveAccel() {
  const v = (process.env.LUNERY_ACCEL || "cpu").toLowerCase();
  return ["cpu", "cuda", "vulkan"].includes(v) ? v : "cpu";
}

/**
 * CUDA variants ship their runtime DLLs in a SEPARATE cudart-* archive.
 * Fetch + extract it and copy every .dll next to the engine binary so the
 * Windows DLL search resolves cudart64_*.dll from the engine dir. No-op
 * unless `cudartAsset` is set (i.e. Windows + cuda only).
 */
export async function fetchAndCopyCudart({ releaseBase, cudartAsset, work, engineDir, logPrefix }) {
  if (!cudartAsset) return;
  const match = releaseBase.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)$/);
  if (!match) {
    throw new Error(`${logPrefix} unsupported release URL for cudart integrity verification.`);
  }
  const [, owner, repo, tag] = match;
  const asset = await resolveGitHubReleaseAsset({ owner, repo, tag, assetName: cudartAsset });
  const cudartUrl = asset.url;
  const cudartArchive = join(work, cudartAsset);
  console.log(`${logPrefix} Downloading CUDA runtime ${cudartUrl}`);
  await downloadFile(cudartUrl, cudartArchive, `${logPrefix} CUDA runtime`);
  await verifySha256File(cudartArchive, asset.sha256, `${logPrefix} CUDA runtime ${asset.name}`);
  const cudartOut = join(work, "cudart");
  mkdirSync(cudartOut, { recursive: true });
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Expand-Archive -LiteralPath '${cudartArchive}' -DestinationPath '${cudartOut}' -Force`],
    { stdio: "inherit" });
  const copyDlls = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) copyDlls(p);
      else if (e.endsWith(".dll")) copyFileSync(p, join(engineDir, e));
    }
  };
  copyDlls(cudartOut);
}
