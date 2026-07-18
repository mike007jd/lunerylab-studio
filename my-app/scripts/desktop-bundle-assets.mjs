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

async function copyDesktopDatabaseRuntime(nodeModulesDir) {
  const prismaMigrationsSource = path.join(root, "prisma", "migrations");
  const runtimeServerSource = path.join(root, "scripts", "desktop-runtime-server.mjs");

  if (!(await exists(prismaMigrationsSource))) {
    throw new Error("[desktop:prepare] prisma migrations are missing");
  }
  if (!(await exists(runtimeServerSource))) {
    throw new Error("[desktop:prepare] desktop runtime wrapper is missing");
  }

  await mkdir(path.join(appOut, "prisma"), { recursive: true });
  await rm(path.join(appOut, "prisma", "migrations"), { recursive: true, force: true });
  await cp(prismaMigrationsSource, path.join(appOut, "prisma", "migrations"), {
    recursive: true,
    dereference: true,
  });
  await cp(runtimeServerSource, path.join(appOut, "desktop-runtime-server.mjs"));

  await copyNodePackage(nodeModulesDir, "@electric-sql/pglite");
  await copyNodePackage(nodeModulesDir, "@electric-sql/pglite-socket");
}

// The recovery page uses a tiny same-origin Tauri IPC shim so script-src 'self'
// is satisfied without a CDN or withGlobalTauri=true. The normal startup path
// is Rust-owned; the fallback UI can only ask Tauri to retry it.
const tauriCoreShim = `export async function invoke(cmd, args = {}, options) {
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") {
    throw new Error("Tauri IPC bridge is unavailable");
  }
  return internals.invoke(cmd, args, options);
}
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
        gap: 12px;
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
      <button id="retry" type="button">Try again</button>`,
  )
  .replace(
    "</style>",
    `button {
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
    </style>`,
  )
  .replace(
    "</body>",
    `<script type="module">
      import { invoke } from "./tauri-core.js";
      const retry = document.getElementById("retry");
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        retry.textContent = "Trying again…";
        await invoke("retry_desktop_runtime").catch(() => {
          retry.disabled = false;
          retry.textContent = "Try again";
        });
      });
    </script>
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
console.log(`Bundled Node runtime: ${nodeSource}`);
await writeFile(path.join(distOut, "index.html"), indexHtml, "utf8");
await writeFile(path.join(distOut, "error.html"), errorHtml, "utf8");
await writeFile(path.join(distOut, "tauri-core.js"), tauriCoreShim, "utf8");

console.log(`Prepared desktop server in ${path.relative(root, outDir)}`);
console.log(`Prepared desktop bootstrap in ${path.relative(root, distOut)}`);
