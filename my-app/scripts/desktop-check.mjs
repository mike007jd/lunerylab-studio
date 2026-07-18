import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();

const placeholders = [
  {
    relative: "desktop-server",
    note: "Temporary placeholder for Tauri resource validation during cargo check.",
  },
  {
    relative: "desktop-dist",
    note: "Temporary placeholder for Tauri frontendDist validation during cargo check.",
  },
  {
    relative: "engine",
    note: "Temporary placeholder for Tauri engine resource validation during cargo check.",
  },
];

async function exists(target) {
  return stat(target).then(
    () => true,
    () => false,
  );
}

const created = [];

try {
  for (const placeholder of placeholders) {
    const absolute = path.join(root, placeholder.relative);
    if (await exists(absolute)) continue;
    await mkdir(absolute, { recursive: true });
    await writeFile(path.join(absolute, ".cargo-check-placeholder"), `${placeholder.note}\n`, "utf8");
    created.push(absolute);
  }

  const checkResult = spawnSync("cargo", ["check", "--manifest-path", path.join("src-tauri", "Cargo.toml")], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });

  if (checkResult.error) throw checkResult.error;
  if (checkResult.status !== 0) {
    process.exitCode = checkResult.status ?? 1;
  } else {
    const testResult = spawnSync("cargo", ["test", "--manifest-path", path.join("src-tauri", "Cargo.toml")], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    if (testResult.error) throw testResult.error;
    process.exitCode = testResult.status ?? 1;
  }
} finally {
  await Promise.all(created.map((absolute) => rm(absolute, { recursive: true, force: true })));
}
