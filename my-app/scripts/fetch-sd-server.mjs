// Fetches the pinned stable-diffusion.cpp `sd` binary for the host platform into
// my-app/engine/sd/ (its own subdir so its shared libs never collide with the
// llama.cpp libs in my-app/engine/). Always refreshes from a verified release
// asset before it replaces the local sidecar.
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { resolveAccel, fetchAndCopyCudart } from "./lib/accel.mjs";
import { installExtractedSidecar } from "./lib/extracted-sidecar.mjs";
import { downloadFile, resolveGitHubReleaseAsset, verifySha256File } from "./lib/integrity.mjs";

const TAG = "master-709-92a3b73";
const ENGINE_DIR = join(import.meta.dirname, "..", "engine", "sd");
const LICENSE_DIR = join(import.meta.dirname, "..", "engine", "licenses");
const LICENSE_PATH = join(LICENSE_DIR, "stable-diffusion.cpp-LICENSE");
// License source checked 2026-07-18 against the pinned release tag.
const LICENSE_URL = "https://raw.githubusercontent.com/leejet/stable-diffusion.cpp/master-709-92a3b73/LICENSE";
const isWin = process.platform === "win32";
const isMacArm = process.platform === "darwin" && process.arch === "arm64";

if (!isWin && !isMacArm) {
  console.error(`[fetch-sd-server] Unsupported host: ${process.platform}/${process.arch}. ` +
    `Module 3 ships macOS-arm64 and Windows-x64 only (Linux/Intel/GPU variants are Module 6).`);
  process.exit(1);
}

// macOS resolves via the GitHub API regex below (the asset name embeds the
// build-runner macOS version) and ignores ACCEL; Windows uses fixed names.
// Asset names use the upstream short tag form `master-baf7eda` (NOT TAG).
const SD_ACCEL = resolveAccel();
const WIN_SD = {
  cpu: { main: "sd-master-92a3b73-bin-win-avx2-x64.zip", cudart: null },
  cuda: {
    main: "sd-master-92a3b73-bin-win-cuda12-x64.zip",
    cudart: "cudart-sd-bin-win-cu12-x64.zip",
  },
  vulkan: { main: "sd-master-92a3b73-bin-win-vulkan-x64.zip", cudart: null },
};
const winAsset = WIN_SD[SD_ACCEL].main;
const winCudartAsset = WIN_SD[SD_ACCEL].cudart;
// The release archive ships the CLI binary as `sd-cli` / `sd-cli.exe` (not `sd`).
const binName = isWin ? "sd-cli.exe" : "sd-cli";
const finalPath = join(ENGINE_DIR, binName);

function runsOk() {
  if (!existsSync(finalPath)) return false;
  // sd.cpp has no --version; --help prints usage. Accept any spawn that is not
  // a spawn failure (ENOENT / Exec format error). Non-zero exit is fine.
  const r = spawnSync(finalPath, ["--help"], { stdio: "ignore" });
  return !r.error;
}

// Resolve the macOS asset by listing the release via the GitHub API.
async function resolveAssetUrl() {
  if (isWin) {
    return resolveGitHubReleaseAsset({
      owner: "leejet",
      repo: "stable-diffusion.cpp",
      tag: TAG,
      assetName: winAsset,
    });
  }
  return resolveGitHubReleaseAsset({
    owner: "leejet",
    repo: "stable-diffusion.cpp",
    tag: TAG,
    assetPattern: /^sd-.*-bin-Darwin-macOS-.*-arm64\.zip$/,
  });
}

mkdirSync(ENGINE_DIR, { recursive: true });
mkdirSync(LICENSE_DIR, { recursive: true });
const work = join(tmpdir(), `sd-${TAG}-${Date.now()}`);
mkdirSync(work, { recursive: true });
const licenseTempPath = join(work, "stable-diffusion.cpp-LICENSE");
console.log(`[fetch-sd-server] Downloading ${LICENSE_URL}`);
await downloadFile(LICENSE_URL, licenseTempPath, "[fetch-sd-server] stable-diffusion.cpp license");
if (statSync(licenseTempPath).size === 0) throw new Error("[fetch-sd-server] stable-diffusion.cpp license is empty");
copyFileSync(licenseTempPath, LICENSE_PATH);
const releaseAsset = await resolveAssetUrl();
const archivePath = join(work, basename(new URL(releaseAsset.url).pathname));

console.log(`[fetch-sd-server] Downloading ${releaseAsset.url}`);
await downloadFile(releaseAsset.url, archivePath, "[fetch-sd-server] stable-diffusion.cpp asset");
await verifySha256File(archivePath, releaseAsset.sha256, `[fetch-sd-server] ${releaseAsset.name}`);

console.log(`[fetch-sd-server] Extracting`);
if (isWin) {
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${work}' -Force`], { stdio: "inherit" });
} else {
  execFileSync("unzip", ["-q", "-o", archivePath, "-d", work], { stdio: "inherit" });
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
  console.error(`[fetch-sd-server] ${err instanceof Error ? err.message : "install failed"}`);
  process.exit(1);
}

if (!isWin) {
  // The upstream binary has an @rpath pointing to the CI runner's build dir.
  // Add @loader_path so dyld resolves libstable-diffusion.dylib from the same dir.
  execFileSync("install_name_tool", ["-add_rpath", "@loader_path", finalPath], { stdio: "inherit" });
}

await fetchAndCopyCudart({
  releaseBase: `https://github.com/leejet/stable-diffusion.cpp/releases/download/${TAG}`,
  cudartAsset: isWin ? winCudartAsset : null,
  work,
  engineDir: ENGINE_DIR,
  logPrefix: "[fetch-sd-server]",
});

rmSync(work, { recursive: true, force: true });

if (!runsOk()) { console.error(`[fetch-sd-server] Fetched binary is not runnable`); process.exit(1); }
console.log(`[fetch-sd-server] Ready: ${finalPath}`);
