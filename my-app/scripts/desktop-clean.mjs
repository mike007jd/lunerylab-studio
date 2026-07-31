import { rm, stat } from "node:fs/promises";
import path from "node:path";

// Runs on every desktop build via tauri.conf.json `beforeBuildCommand`
// (`pnpm desktop:clean && pnpm build && pnpm desktop:prepare`). Its job is to
// guarantee a build can NEVER ship stale UI: the classic failure is editing a
// component, rebuilding, and still seeing the old screen because `next build`
// reused a stale `.next/standalone`, or because the OS opened a previously
// bundled `.app`. So we wipe every artifact that can carry old frontend/app
// state before the fresh build regenerates them.
//
// We deliberately do NOT delete the whole `src-tauri/target` Rust cache: UI
// freshness comes from the frontend/server artifacts and the packaged bundle,
// not the Rust object cache, and nuking `target` would turn every build into a
// full multi-minute recompile for zero correctness benefit. Only `target/**/bundle`
// (the packaged .app/.dmg/.exe outputs) is removed so no old installer lingers.

const root = process.cwd();

const targets = [
  // Next.js build output — the standalone server bundled into the desktop app.
  // This is the #1 source of "I changed the code but the build shows old UI".
  ".next",
  // Defensive: only present if a static export is ever configured.
  "out",
  // Staged desktop server + bootstrap shell that get embedded as Tauri resources.
  "desktop-server",
  "desktop-dist",
  // Packaged app artifacts (.app / .dmg / .nsis). Wipe both profiles so the
  // user never opens a previously bundled binary by mistake.
  path.join("src-tauri", "target", "release", "bundle"),
  path.join("src-tauri", "target", "debug", "bundle"),
  // Tauri resource staging copies of desktop-server/engine. These are not the
  // Rust object cache; leaving them makes `target/` grow by ~1GB per profile
  // and can keep stale UI/server bytes next to a fresh source tree.
  path.join("src-tauri", "target", "release", "_up_"),
  path.join("src-tauri", "target", "debug", "_up_"),
  // TypeScript incremental cache — regenerable and gitignored.
  "tsconfig.tsbuildinfo",
];

const removed = [];
await Promise.all(
  targets.map(async (relative) => {
    const absolute = path.join(root, relative);
    const existed = await stat(absolute).then(
      () => true,
      () => false,
    );
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    if (existed) removed.push(relative);
  }),
);

if (removed.length > 0) {
  console.log(`Cleaned stale build/bundle artifacts:\n  - ${removed.join("\n  - ")}`);
} else {
  console.log("No stale build/bundle artifacts to clean.");
}
