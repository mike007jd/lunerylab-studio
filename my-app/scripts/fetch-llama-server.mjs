// Fetches and verifies the pinned llama.cpp `llama-server` binary for the host
// platform into my-app/engine/. Always refreshes from a release asset whose
// digest is verified before it replaces the local sidecar.
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAccel, fetchAndCopyCudart } from "./lib/accel.mjs";
import { installExtractedSidecar } from "./lib/extracted-sidecar.mjs";
import { downloadFile, resolveGitHubReleaseAsset, verifySha256File } from "./lib/integrity.mjs";

const TAG = "b9209";
const ENGINE_DIR = join(import.meta.dirname, "..", "engine");
const LICENSE_DIR = join(ENGINE_DIR, "licenses");
const LICENSE_PATH = join(LICENSE_DIR, "llama.cpp-LICENSE");
// License source checked 2026-07-18 against the pinned release tag.
const LICENSE_URL = "https://raw.githubusercontent.com/ggml-org/llama.cpp/b9209/LICENSE";
const isWin = process.platform === "win32";
const isMacArm = process.platform === "darwin" && process.arch === "arm64";

if (!isWin && !isMacArm) {
  console.error(`[fetch-llama-server] Unsupported host: ${process.platform}/${process.arch}. ` +
    `Module 2 ships macOS-arm64 and Windows-x64 only (Linux/Intel are out of scope).`);
  process.exit(1);
}

// Windows-only accel variant; macOS arm64 is always the Metal-enabled upstream
// arm64 build and ignores ACCEL, so the default mac path stays byte-identical.
const ACCEL = resolveAccel();
// 12.4 is pinned over 13.1 for broader installed-driver compat; its CUDA
// runtime ships in a separate cudart-* archive (verified via the release API).
const WIN_LLAMA = {
  cpu: { main: `llama-${TAG}-bin-win-cpu-x64.zip`, cudart: null },
  cuda: {
    main: `llama-${TAG}-bin-win-cuda-12.4-x64.zip`,
    cudart: "cudart-llama-bin-win-cuda-12.4-x64.zip",
  },
  vulkan: { main: `llama-${TAG}-bin-win-vulkan-x64.zip`, cudart: null },
};
const asset = isWin ? WIN_LLAMA[ACCEL].main : `llama-${TAG}-bin-macos-arm64.tar.gz`;
const cudartAsset = isWin ? WIN_LLAMA[ACCEL].cudart : null;
const RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}`;
const binName = isWin ? "llama-server.exe" : "llama-server";
const finalPath = join(ENGINE_DIR, binName);

function runsOk() {
  if (!existsSync(finalPath)) return false;
  try { execFileSync(finalPath, ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

mkdirSync(ENGINE_DIR, { recursive: true });
mkdirSync(LICENSE_DIR, { recursive: true });
const work = join(tmpdir(), `llama-${TAG}-${Date.now()}`);
mkdirSync(work, { recursive: true });
const licenseTempPath = join(work, "llama.cpp-LICENSE");
console.log(`[fetch-llama-server] Downloading ${LICENSE_URL}`);
await downloadFile(LICENSE_URL, licenseTempPath, "[fetch-llama-server] llama.cpp license");
if (statSync(licenseTempPath).size === 0) throw new Error("[fetch-llama-server] llama.cpp license is empty");
copyFileSync(licenseTempPath, LICENSE_PATH);
const archivePath = join(work, asset);
const releaseAsset = await resolveGitHubReleaseAsset({
  owner: "ggml-org",
  repo: "llama.cpp",
  tag: TAG,
  assetName: asset,
});

console.log(`[fetch-llama-server] Downloading ${releaseAsset.url}`);
await downloadFile(releaseAsset.url, archivePath, "[fetch-llama-server] llama.cpp asset");
await verifySha256File(archivePath, releaseAsset.sha256, `[fetch-llama-server] ${releaseAsset.name}`);

console.log(`[fetch-llama-server] Extracting`);
if (isWin) {
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${work}' -Force`], { stdio: "inherit" });
} else {
  execFileSync("tar", ["-xzf", archivePath, "-C", work], { stdio: "inherit" });
}

try {
  installExtractedSidecar({
    workDir: work,
    binName,
    finalPath,
    engineDir: ENGINE_DIR,
    executable: !isWin,
    siblingExtensions: [isWin ? ".dll" : ".dylib"],
  });
} catch (err) {
  console.error(`[fetch-llama-server] ${err instanceof Error ? err.message : "install failed"}`);
  process.exit(1);
}

await fetchAndCopyCudart({
  releaseBase: RELEASE_BASE,
  cudartAsset,
  work,
  engineDir: ENGINE_DIR,
  logPrefix: "[fetch-llama-server]",
});

rmSync(work, { recursive: true, force: true });

if (!runsOk()) { console.error(`[fetch-llama-server] Fetched binary is not runnable`); process.exit(1); }
console.log(`[fetch-llama-server] Ready: ${finalPath}`);
