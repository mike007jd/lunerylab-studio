import { access, chmod, cp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { downloadFile, verifyNodeOfficialSha } from "./lib/integrity.mjs";

const root = process.cwd();
const standaloneRoot = path.join(root, ".next", "standalone");
const standaloneApp = path.join(standaloneRoot, "my-app");
const serverSource = await exists(path.join(standaloneApp, "server.js")) ? standaloneApp : standaloneRoot;
const outDir = path.join(root, "desktop-server");
const appOut = path.join(outDir, "app");
const binOut = path.join(outDir, "bin");
const distOut = path.join(root, "desktop-dist");

// Pinned Node runtime — uses the official nodejs.org static prebuilt, which
// only depends on macOS system frameworks (CoreFoundation, libSystem, libc++)
// and is therefore safe to redistribute. brew/asdf builds of recent Node
// (24+) link against shared dylibs at /opt/homebrew/* and CANNOT be bundled —
// shipping them results in a `Library not loaded: @rpath/libnode.NNN.dylib`
// dyld crash the first time the user launches the .app.
//
// Set LUNERY_DESKTOP_NODE_PATH to override (e.g. CI snapshotting a specific
// runtime). Otherwise we fetch and cache the pinned tarball below.
const NODE_PINNED_VERSION = "v22.23.1";
const cacheDir = path.join(os.homedir(), ".cache", "lunerylab", "desktop-node");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveBundledNode() {
  if (process.env.LUNERY_DESKTOP_NODE_PATH) {
    return process.env.LUNERY_DESKTOP_NODE_PATH;
  }
  const supportMatrix = {
    "darwin/arm64": { tarball: `node-${NODE_PINNED_VERSION}-darwin-arm64`, archiveExt: "tar.xz", binPath: "bin/node" },
    "darwin/x64": { tarball: `node-${NODE_PINNED_VERSION}-darwin-x64`, archiveExt: "tar.xz", binPath: "bin/node" },
    // Windows builds use the official `win-x64.zip`. The previous fallback to
    // `process.execPath` shipped whatever Node the dev's machine happened to
    // have — including brew/scoop/asdf builds with non-redistributable
    // dependencies — straight into the installer. Always pull + verify SHA.
    "win32/x64": { tarball: `node-${NODE_PINNED_VERSION}-win-x64`, archiveExt: "zip", binPath: "node.exe" },
  };
  const platformKey = `${process.platform}/${process.arch}`;
  const support = supportMatrix[platformKey];
  if (!support) {
    throw new Error(
      `[desktop:prepare] No pinned Node tarball for ${platformKey}. Set LUNERY_DESKTOP_NODE_PATH to a verified Node binary or add the platform to the supportMatrix.`,
    );
  }
  const { tarball, archiveExt, binPath } = support;
  const versionDir = path.join(cacheDir, NODE_PINNED_VERSION);
  const extractedRoot = path.join(versionDir, tarball);
  const extracted = path.join(extractedRoot, binPath);
  mkdirSync(versionDir, { recursive: true });
  const archiveName = `${tarball}.${archiveExt}`;
  const archivePath = path.join(versionDir, archiveName);
  if (!existsSync(archivePath)) {
    const url = `https://nodejs.org/dist/${NODE_PINNED_VERSION}/${archiveName}`;
    console.log(`[desktop:prepare] Fetching pinned Node runtime: ${url}`);
    await downloadFile(url, archivePath, "Node runtime");
  }
  await verifyNodeOfficialSha({
    version: NODE_PINNED_VERSION,
    fileName: archiveName,
    filePath: archivePath,
  });
  rmSync(extractedRoot, { recursive: true, force: true });
  if (archiveExt === "zip") {
    // PowerShell ships on every supported Windows; `Expand-Archive` is also
    // available on macOS/Linux runners with `pwsh` so this works in CI.
    const extract = spawnSync(
      process.platform === "win32" ? "powershell" : "unzip",
      process.platform === "win32"
        ? ["-NoProfile", "-Command", `Expand-Archive -Path '${archivePath}' -DestinationPath '${versionDir}' -Force`]
        : ["-q", archivePath, "-d", versionDir],
    );
    if (extract.status !== 0) {
      throw new Error(`Failed to extract Node zip: ${extract.stderr?.toString() ?? ""}`);
    }
  } else {
    const extract = spawnSync("tar", ["-xf", archivePath, "-C", versionDir]);
    if (extract.status !== 0) {
      throw new Error(`Failed to extract Node tarball: ${extract.stderr?.toString() ?? ""}`);
    }
  }
  if (!existsSync(extracted)) {
    throw new Error(`Node binary not present after extraction: ${extracted}`);
  }
  return extracted;
}

function assertBundleableNode(nodeBinary) {
  if (process.platform !== "darwin") return;
  const result = spawnSync("otool", ["-L", nodeBinary]);
  if (result.status !== 0) {
    throw new Error(`otool -L failed on ${nodeBinary}: ${result.stderr?.toString() ?? ""}`);
  }
  const output = result.stdout.toString();
  const forbidden = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line.startsWith("/opt/homebrew/") ||
      line.startsWith("/usr/local/Cellar/") ||
      /libnode\.\d+\.dylib/.test(line),
    );
  if (forbidden.length > 0) {
    throw new Error(
      `Refusing to bundle Node runtime with non-redistributable dependencies — every dependency must be a macOS system framework. Offending lines:\n${forbidden.join("\n")}`,
    );
  }
}

function assertSharpRuntime(nodeBinary) {
  const smoke = spawnSync(
    nodeBinary,
    [
      "-e",
      `require("sharp")({
        create: {
          width: 1,
          height: 1,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      }).png().toBuffer().then(() => process.stdout.write("sharp-ok")).catch((error) => {
        console.error(error);
        process.exit(1);
      });`,
    ],
    {
      cwd: appOut,
      encoding: "utf8",
    },
  );
  if (smoke.status !== 0 || smoke.stdout.trim() !== "sharp-ok") {
    throw new Error(
      `[desktop:prepare] Bundled sharp runtime failed: ${smoke.stderr?.trim() || smoke.error?.message || "unknown error"}`,
    );
  }
  console.log("[desktop:prepare] sharp runtime smoke OK");
}

async function repairPnpmFacadePackages(nodeModulesDir) {
  const facadeRoot = path.join(nodeModulesDir, ".pnpm", "node_modules");
  if (!(await exists(facadeRoot))) return;

  for (const entry of await readdir(facadeRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const source = path.join(facadeRoot, entry.name);

    if (entry.name.startsWith("@")) {
      const scopedTarget = path.join(nodeModulesDir, entry.name);
      await mkdir(scopedTarget, { recursive: true });
      for (const scopedEntry of await readdir(source, { withFileTypes: true })) {
        const scopedSource = path.join(source, scopedEntry.name);
        const target = path.join(scopedTarget, scopedEntry.name);
        await rm(target, { recursive: true, force: true });
        await cp(scopedSource, target, { recursive: true, dereference: true });
      }
      continue;
    }

    const target = path.join(nodeModulesDir, entry.name);
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true, dereference: true });
  }
}

async function copyGeneratedPrismaClient(nodeModulesDir) {
  const prismaClientPath = path.join(root, "node_modules", "@prisma", "client");
  if (!(await exists(prismaClientPath))) return;

  const realClientPath = await realpath(prismaClientPath);
  const source = path.resolve(realClientPath, "..", "..", ".prisma");
  if (!(await exists(source))) return;

  const target = path.join(nodeModulesDir, ".prisma");
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true, dereference: true });
}

async function copyNodePackage(nodeModulesDir, packageName) {
  const source = path.join(root, "node_modules", ...packageName.split("/"));
  if (!(await exists(source))) {
    throw new Error(`[desktop:prepare] Required runtime package is missing: ${packageName}`);
  }
  const realSource = await realpath(source);
  const target = path.join(nodeModulesDir, ...packageName.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(realSource, target, { recursive: true, dereference: true });
}

async function copyNodePackageDependency(nodeModulesDir, ownerName, packageName) {
  const ownerSource = path.join(root, "node_modules", ...ownerName.split("/"));
  if (!(await exists(ownerSource))) {
    throw new Error(`[desktop:prepare] Runtime package owner is missing: ${ownerName}`);
  }

  const ownerRealSource = await realpath(ownerSource);
  const source = path.join(
    path.dirname(ownerRealSource),
    ...packageName.split("/"),
  );
  if (!(await exists(source))) {
    throw new Error(
      `[desktop:prepare] Required ${ownerName} runtime dependency is missing: ${packageName}`,
    );
  }

  const realSource = await realpath(source);
  const target = path.join(nodeModulesDir, ...packageName.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(realSource, target, { recursive: true, dereference: true });
}

async function copySharpRuntime(nodeModulesDir) {
  const runtimePackages = {
    "darwin/arm64": [
      "@img/colour",
      "@img/sharp-darwin-arm64",
      "@img/sharp-libvips-darwin-arm64",
    ],
    "darwin/x64": [
      "@img/colour",
      "@img/sharp-darwin-x64",
      "@img/sharp-libvips-darwin-x64",
    ],
    "win32/x64": [
      "@img/colour",
      "@img/sharp-win32-x64",
    ],
  }[`${process.platform}/${process.arch}`];

  if (!runtimePackages) {
    throw new Error(
      `[desktop:prepare] No sharp runtime package set for ${process.platform}/${process.arch}.`,
    );
  }

  await copyNodePackage(nodeModulesDir, "sharp");
  for (const packageName of runtimePackages) {
    await copyNodePackageDependency(nodeModulesDir, "sharp", packageName);
  }
}

async function copyDesktopDatabaseRuntime(nodeModulesDir) {
  const prismaMigrationsSource = path.join(root, "prisma", "migrations");
  const runtimeServerSource = path.join(root, "scripts", "desktop-runtime-server.mjs");
  const migrationRuntimeSource = path.join(root, "scripts", "desktop-pglite-migrations.mjs");

  if (!(await exists(prismaMigrationsSource))) {
    throw new Error("[desktop:prepare] prisma migrations are missing");
  }
  if (!(await exists(runtimeServerSource))) {
    throw new Error("[desktop:prepare] desktop runtime wrapper is missing");
  }
  if (!(await exists(migrationRuntimeSource))) {
    throw new Error("[desktop:prepare] desktop migration runtime is missing");
  }

  await mkdir(path.join(appOut, "prisma"), { recursive: true });
  await rm(path.join(appOut, "prisma", "migrations"), { recursive: true, force: true });
  await cp(prismaMigrationsSource, path.join(appOut, "prisma", "migrations"), {
    recursive: true,
    dereference: true,
  });
  await cp(runtimeServerSource, path.join(appOut, "desktop-runtime-server.mjs"));
  await cp(migrationRuntimeSource, path.join(appOut, "desktop-pglite-migrations.mjs"));

  await copyNodePackage(nodeModulesDir, "@electric-sql/pglite");
  await copyNodePackage(nodeModulesDir, "@electric-sql/pglite-socket");
}

// The recovery page uses same-origin modules so script-src 'self' stays strict
// without a CDN or withGlobalTauri=true. The normal startup path is Rust-owned;
// this bootstrap surface only exposes the bounded recovery commands registered
// by Tauri.
const tauriCoreShim = `export async function invoke(cmd, args = {}, options) {
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") {
    throw new Error("Tauri IPC bridge is unavailable");
  }
  return internals.invoke(cmd, args, options);
}
`;

const DESKTOP_WORKSPACE_RESET_CONFIRMATION = "DELETE_LUNERY_WORKSPACE";

const errorScript = `import { invoke } from "./tauri-core.js";

const RETRY_TIMEOUT_MS = 35_000;
const DESKTOP_WORKSPACE_RESET_CONFIRMATION = ${JSON.stringify(DESKTOP_WORKSPACE_RESET_CONFIRMATION)};
const status = document.getElementById("status");
const retry = document.getElementById("retry");
const openData = document.getElementById("open-data");
const requestDelete = document.getElementById("request-delete");
const deleteConfirmation = document.getElementById("delete-confirmation");
const cancelDelete = document.getElementById("cancel-delete");
const confirmDelete = document.getElementById("confirm-delete");
const controls = [retry, openData, requestDelete, cancelDelete, confirmDelete];
let retryAttempt = 0;

function setStatus(message, tone = "neutral") {
  status.textContent = message;
  status.dataset.tone = tone;
}

function setBusy(busy) {
  for (const control of controls) control.disabled = busy;
  document.body.setAttribute("aria-busy", busy ? "true" : "false");
}

function restoreRetry(attempt, message) {
  if (attempt !== retryAttempt) return;
  setBusy(false);
  retry.textContent = "Try again";
  setStatus(message, "error");
  retry.focus();
}

retry.addEventListener("click", async () => {
  const attempt = ++retryAttempt;
  setBusy(true);
  retry.textContent = "Trying again…";
  setStatus("Starting Studio…");
  window.setTimeout(() => {
    restoreRetry(attempt, "Studio still couldn't start. Try again or delete the workspace data below.");
  }, RETRY_TIMEOUT_MS);

  try {
    await invoke("retry_desktop_runtime");
  } catch {
    restoreRetry(attempt, "Studio couldn't retry. Try again or delete the workspace data below.");
  }
});

openData.addEventListener("click", async () => {
  openData.disabled = true;
  openData.textContent = "Opening…";
  try {
    await invoke("open_desktop_profile_folder");
    setStatus("Opened the Lunery data folder.");
  } catch {
    setStatus("The Lunery data folder couldn't be opened.", "error");
  } finally {
    openData.disabled = false;
    openData.textContent = "Open data folder";
  }
});

requestDelete.addEventListener("click", () => {
  deleteConfirmation.hidden = false;
  requestDelete.setAttribute("aria-expanded", "true");
  confirmDelete.focus();
});

cancelDelete.addEventListener("click", () => {
  deleteConfirmation.hidden = true;
  requestDelete.setAttribute("aria-expanded", "false");
  requestDelete.focus();
});

confirmDelete.addEventListener("click", async () => {
  setBusy(true);
  confirmDelete.textContent = "Deleting workspace data…";
  setStatus("Deleting workspace data and restarting Studio…");
  try {
    await invoke("reset_desktop_workspace", {
      confirmation: DESKTOP_WORKSPACE_RESET_CONFIRMATION,
    });
  } catch {
    setBusy(false);
    confirmDelete.textContent = "Delete workspace data";
    setStatus("Workspace data couldn't be deleted. Open the data folder or try again.", "error");
    confirmDelete.focus();
  }
});
`;

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Lunery Lab Studio</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #090807;
        --border: rgba(255, 255, 255, 0.1);
        --text: #f4efe6;
        --muted: #9d9588;
        --accent: #d6b35a;
        --accent-soft: rgba(214, 179, 90, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        display: grid;
        place-items: center;
        width: min(560px, calc(100vw - 48px));
        gap: 14px;
        text-align: center;
      }
      .mark {
        display: inline-grid;
        width: 40px;
        height: 40px;
        place-items: center;
        border-radius: 14px;
        background: var(--accent-soft);
        color: var(--accent);
        font-weight: 700;
      }
      h1 {
        margin: 0;
        font-size: 18px;
        line-height: 1.1;
        font-weight: 650;
      }
      p {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.55;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">LL</div>
      <h1>Lunery Lab Studio</h1>
      <p>Starting Studio…</p>
    </main>
  </body>
</html>`;

const errorHtml = indexHtml
  .replace("<title>Lunery Lab Studio</title>", "<title>Lunery Lab Studio — Startup problem</title>")
  .replace(
    "<h1>Lunery Lab Studio</h1>\n      <p>Starting Studio…</p>",
    `<h1>Studio couldn't start</h1>
      <p id="status" role="alert">Technical details were saved in the Lunery Logs folder.</p>
      <div class="actions">
        <button id="retry" type="button">Try again</button>
        <button id="open-data" class="secondary" type="button">Open data folder</button>
        <button id="request-delete" class="danger" type="button" aria-expanded="false" aria-controls="delete-confirmation">Delete workspace data</button>
      </div>
      <section id="delete-confirmation" class="confirmation" aria-labelledby="delete-title" hidden>
        <h2 id="delete-title">Permanently delete workspace data?</h2>
        <p>Projects, canvases, media files, and recovery copies in this workspace will be permanently deleted. Models and service connections stay on this computer. This cannot be undone.</p>
        <div class="confirmation-actions">
          <button id="cancel-delete" class="secondary" type="button">Cancel</button>
          <button id="confirm-delete" class="danger solid" type="button">Delete workspace data</button>
        </div>
      </section>`,
  )
  .replace(
    "</style>",
    `.actions, .confirmation-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 10px;
      }
      button {
        min-height: 40px;
        border: 1px solid var(--accent);
        border-radius: 10px;
        padding: 0 16px;
        background: var(--accent);
        color: var(--bg);
        font: inherit;
        font-size: 14px;
        font-weight: 650;
        cursor: pointer;
      }
      button:focus-visible { outline: 2px solid var(--text); outline-offset: 3px; }
      button:disabled { cursor: wait; opacity: 0.65; }
      button.secondary {
        border-color: var(--border);
        background: transparent;
        color: var(--text);
      }
      button.danger {
        border-color: #d7685d;
        background: transparent;
        color: #ef8b80;
      }
      button.danger.solid {
        background: #c84f44;
        color: #fff;
      }
      .confirmation {
        width: 100%;
        padding: 18px;
        border: 1px solid rgba(215, 104, 93, 0.45);
        border-radius: 14px;
        background: rgba(215, 104, 93, 0.08);
      }
      .confirmation[hidden] { display: none; }
      .confirmation h2 {
        margin: 0 0 8px;
        font-size: 15px;
      }
      .confirmation-actions { margin-top: 14px; }
      #status[data-tone="error"] { color: #ef8b80; }
    </style>`,
  )
  .replace(
    "</body>",
    `<script type="module" src="./error.js"></script>
  </body>`,
  );

await rm(outDir, { recursive: true, force: true });
await rm(distOut, { recursive: true, force: true });
await mkdir(appOut, { recursive: true });
await mkdir(binOut, { recursive: true });
await mkdir(distOut, { recursive: true });

await cp(serverSource, appOut, {
  recursive: true,
  dereference: true,
  filter: (source) => !source.includes(`${path.sep}.next${path.sep}cache${path.sep}`),
});
await repairPnpmFacadePackages(path.join(appOut, "node_modules"));
await copyGeneratedPrismaClient(path.join(appOut, "node_modules"));
await copyDesktopDatabaseRuntime(path.join(appOut, "node_modules"));
await copySharpRuntime(path.join(appOut, "node_modules"));

await cp(path.join(root, ".next", "static"), path.join(appOut, ".next", "static"), { recursive: true });
if (await exists(path.join(root, "public"))) {
  await cp(path.join(root, "public"), path.join(appOut, "public"), { recursive: true });
}

const nodeSource = await resolveBundledNode();
assertBundleableNode(nodeSource);
const nodeTarget = path.join(binOut, process.platform === "win32" ? "node.exe" : "node");
await cp(nodeSource, nodeTarget);
await chmod(nodeTarget, 0o755);
assertBundleableNode(nodeTarget);
assertSharpRuntime(nodeTarget);
console.log(`Bundled Node runtime: ${nodeSource}`);
await writeFile(path.join(distOut, "index.html"), indexHtml, "utf8");
await writeFile(path.join(distOut, "error.html"), errorHtml, "utf8");
await writeFile(path.join(distOut, "tauri-core.js"), tauriCoreShim, "utf8");
await writeFile(path.join(distOut, "error.js"), errorScript, "utf8");

console.log(`Prepared desktop server in ${path.relative(root, outDir)}`);
console.log(`Prepared desktop bootstrap in ${path.relative(root, distOut)}`);
