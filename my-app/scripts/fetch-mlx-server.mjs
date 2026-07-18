// Fetches the pinned SwiftLM (Swift+MLX OpenAI server) binary into
// my-app/engine/mlx/ (own subdir so its mlx.metallib/dylibs never collide with
// the llama.cpp or sd.cpp libs). macOS-arm64 ONLY — MLX is Apple-Silicon-only,
// so on any other host this GRACEFULLY SKIPS (exit 0) instead of failing, or it
// would break the Windows desktop:prepare chain (which has no MLX). macOS-arm64
// hosts always refresh from a verified release asset before replacing the local
// sidecar.
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installExtractedSidecar } from "./lib/extracted-sidecar.mjs";
import { downloadFile, resolveGitHubReleaseAsset, verifySha256File } from "./lib/integrity.mjs";

const TAG = "b648";
const ASSET = "SwiftLM-b648-macos-arm64.tar.gz";
const ENGINE_DIR = join(import.meta.dirname, "..", "engine", "mlx");
const LICENSE_DIR = join(import.meta.dirname, "..", "engine", "licenses");
const LICENSE_PATH = join(LICENSE_DIR, "SwiftLM-LICENSE");
// License source checked 2026-07-18 against the pinned release tag.
const LICENSE_URL = "https://raw.githubusercontent.com/SharpAI/SwiftLM/b648/LICENSE";
const isMacArm = process.platform === "darwin" && process.arch === "arm64";

if (!isMacArm) {
  console.log(`[fetch-mlx-server] Host ${process.platform}/${process.arch} is not macOS-arm64. ` +
    `MLX is Apple-Silicon-only — skipping (this is expected on Windows/Linux/Intel builds).`);
  process.exit(0); // graceful skip — must NOT break desktop:prepare on non-Mac
}

const binName = "SwiftLM";
const finalPath = join(ENGINE_DIR, binName);

function runsOk() {
  if (!existsSync(finalPath)) return false;
  // We only need to confirm the binary is an exec'able Mach-O, not that a flag
  // works. `--version` may print+exit or may be unknown; a timeout still means
  // it spawned. Treat spawn-success OR timeout as runnable; only ENOENT / Exec
  // format error (r.error with those codes) means broken.
  const r = spawnSync(finalPath, ["--version"], { timeout: 8000, stdio: "ignore" });
  return !r.error || r.error.code === "ETIMEDOUT";
}

mkdirSync(ENGINE_DIR, { recursive: true });
mkdirSync(LICENSE_DIR, { recursive: true });
const work = join(tmpdir(), `swiftlm-${TAG}-${Date.now()}`);
mkdirSync(work, { recursive: true });
const licenseTempPath = join(work, "SwiftLM-LICENSE");
console.log(`[fetch-mlx-server] Downloading ${LICENSE_URL}`);
await downloadFile(LICENSE_URL, licenseTempPath, "[fetch-mlx-server] SwiftLM license");
if (statSync(licenseTempPath).size === 0) throw new Error("[fetch-mlx-server] SwiftLM license is empty");
copyFileSync(licenseTempPath, LICENSE_PATH);
const archivePath = join(work, ASSET);
const releaseAsset = await resolveGitHubReleaseAsset({
  owner: "SharpAI",
  repo: "SwiftLM",
  tag: TAG,
  assetName: ASSET,
});

console.log(`[fetch-mlx-server] Downloading ${releaseAsset.url}`);
await downloadFile(releaseAsset.url, archivePath, "[fetch-mlx-server] SwiftLM asset");
await verifySha256File(archivePath, releaseAsset.sha256, `[fetch-mlx-server] ${releaseAsset.name}`);

console.log(`[fetch-mlx-server] Extracting`);
execFileSync("tar", ["-xzf", archivePath, "-C", work], { stdio: "inherit" });

try {
  installExtractedSidecar({
    workDir: work,
    binName,
    finalPath,
    engineDir: ENGINE_DIR,
    siblingExtensions: [".dylib", ".metallib"],
  });
} catch (err) {
  console.error(`[fetch-mlx-server] ${err instanceof Error ? err.message : "install failed"}`);
  process.exit(1);
}

// Some Swift release binaries hard-code the CI runner's rpath. Add @loader_path
// so dyld resolves the sibling libs we just copied (mirrors fetch-sd-server.mjs).
try {
  execFileSync("install_name_tool", ["-add_rpath", "@loader_path", finalPath], { stdio: "ignore" });
} catch {
  // -add_rpath fails if the rpath already exists — harmless, the bundled
  // mlx.metallib + libs sit next to the binary regardless.
}

rmSync(work, { recursive: true, force: true });

if (!runsOk()) { console.error(`[fetch-mlx-server] Fetched binary is not runnable`); process.exit(1); }
console.log(`[fetch-mlx-server] Ready: ${finalPath}`);
