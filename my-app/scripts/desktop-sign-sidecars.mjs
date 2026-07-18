// Sign all third-party native binaries under desktop-server/ and engine/ with
// the Developer ID Application certificate so that Apple notarization accepts
// the bundle. Notarization requires every executable / dylib / .node inside the
// .app to be signed with a valid Developer ID certificate, have the hardened
// runtime enabled, AND include a secure timestamp. Tauri only signs the main
// app binary; resources we ship (Node sidecar server with sharp/Prisma native
// modules, downloaded ML engines) may be unsigned third-party builds and must
// be signed here when their existing signature is not already acceptable.
//
// IMPORTANT: ad-hoc signing (--sign -) is NOT sufficient. Ad-hoc signatures
// cannot obtain a secure timestamp from Apple, and notarization rejects
// timestampless binaries. We must use the real Developer ID Application
// identity (same one Tauri uses for the main bundle), passed via the
// APPLE_SIGNING_IDENTITY env var. Do not blindly re-sign already valid runtime
// binaries: Node's V8 JIT can crash after replacing the upstream Developer ID
// signature, even when codesign verification still says the file is valid.
//
// Run after desktop-bundle-assets.mjs (which populates desktop-server/) and
// after fetch-*-server.mjs (which populate engine/). Skipped on non-macOS.

import { spawnSync } from "node:child_process";
import { readdir, stat, chmod } from "node:fs/promises";
import path from "node:path";

import { DESKTOP_SIGNING_ENV_KEYS, loadLocalEnv } from "./lib/load-local-env.mjs";

const root = process.cwd();

const TARGET_DIRS = [
  path.join(root, "desktop-server"),
  path.join(root, "engine"),
];

if (process.platform !== "darwin") {
  console.log("[desktop-sign-sidecars] non-macOS, skipping");
  process.exit(0);
}

loadLocalEnv({ cwd: root, keys: DESKTOP_SIGNING_ENV_KEYS });

// Mach-O magic numbers (little + big endian) for 64-bit and 32-bit, plus the
// universal (fat) header. Lets us cheaply detect native binaries without
// shelling out to `file` for every file.
const MACH_O_MAGICS = new Set([
  0xfeedfacf, // MH_MAGIC_64
  0xfeedface, // MH_MAGIC
  0xcffaedfe, // MH_MAGIC_64 (swapped)
  0xcefaedfe, // MH_MAGIC (swapped)
  0xcafebabe, // FAT_MAGIC (universal)
  0xbebafeca, // FAT_MAGIC (swapped)
]);

function readUint32LE(buf, off) {
  return buf.readUInt32LE(off);
}
function readUint32BE(buf, off) {
  return buf.readUInt32BE(off);
}

function isMachO(buf) {
  if (buf.length < 4) return false;
  return (
    MACH_O_MAGICS.has(readUint32LE(buf, 0)) ||
    MACH_O_MAGICS.has(readUint32BE(buf, 0))
  );
}

const skippedDirs = new Set([
  ".DS_Store",
  ".cache",
  ".git",
  "node_modules/.cache",
]);

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (skippedDirs.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Skip into nested dirs but keep walking.
      await walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function codesignWithDeveloperId(file, identity) {
  // --force: replace any existing signature (e.g. sharp ships its own adhoc).
  // --options runtime: enable hardened runtime (required by notarization).
  // --timestamp: secure timestamp from Apple (REQUIRED by notarization; only
  //   obtainable when signing with a real Developer ID certificate).
  // --sign <identity>: the Developer ID Application identity.
  const r = spawnSync(
    "codesign",
    [
      "--force",
      "--options", "runtime",
      "--timestamp",
      "--sign", identity,
      file,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(
      `[desktop-sign-sidecars] FAILED: ${path.relative(root, file)}\n  ${r.stderr?.trim()}`,
    );
    return false;
  }
  return true;
}

function verifySignature(file) {
  const detail = spawnSync("codesign", ["-dvvv", file], { encoding: "utf8" });
  // codesign writes detail to stderr.
  const out = `${detail.stdout}\n${detail.stderr}`;
  const verify = spawnSync("codesign", ["--verify", "--strict", "--verbose=2", file], { encoding: "utf8" });
  const hasAuthority = /Authority=Developer ID Application:/i.test(out);
  const hasTimestamp = /^Timestamp=/m.test(out);
  const hasRuntime = /flags=0x[0-9a-f]+\([^)]*runtime/i.test(out);
  return {
    ok: detail.status === 0 && verify.status === 0,
    hasAuthority,
    hasTimestamp,
    hasRuntime,
    raw: `${out}\n${verify.stdout}\n${verify.stderr}`,
  };
}

function signatureIsAcceptable(file) {
  const v = verifySignature(file);
  return v.ok && v.hasAuthority && v.hasTimestamp && v.hasRuntime;
}

function assertNodeRuntimeWorks(file) {
  const version = spawnSync(file, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    throw new Error(
      `[desktop-sign-sidecars] Bundled Node cannot print --version: ${version.stderr || version.error?.message || "unknown error"}`,
    );
  }
  const smoke = spawnSync(file, ["-e", 'console.log("node-ok")'], { encoding: "utf8" });
  if (smoke.status !== 0 || smoke.stdout.trim() !== "node-ok") {
    throw new Error(
      `[desktop-sign-sidecars] Bundled Node cannot execute JavaScript after signing: ` +
        `status=${smoke.status} stdout=${JSON.stringify(smoke.stdout)} stderr=${JSON.stringify(smoke.stderr)}`,
    );
  }
  console.log(`[desktop-sign-sidecars] node smoke OK: ${version.stdout.trim()} ${path.relative(root, file)}`);
}

const identity = process.env.APPLE_SIGNING_IDENTITY;
if (!identity) {
  if (process.env.LUNERY_LOCAL_UNSIGNED_BUILD === "1") {
    console.warn(
      "[desktop-sign-sidecars] LUNERY_LOCAL_UNSIGNED_BUILD=1; skipping Developer ID sidecar signing for a local-only package.",
    );
    process.exit(0);
  }
  console.error(
    "[desktop-sign-sidecars] APPLE_SIGNING_IDENTITY env var is required " +
      "(e.g. \"Developer ID Application: Your Name (TEAMID)\"). " +
      "Notarization needs a real Developer ID signature with a secure timestamp; " +
      "ad-hoc signing is not sufficient.",
  );
  process.exit(1);
}
console.log(`[desktop-sign-sidecars] identity: ${identity}`);

const files = [];
for (const d of TARGET_DIRS) {
  try {
    const st = await stat(d);
    if (st.isDirectory()) files.push(...(await walk(d)));
  } catch {
    console.log(`[desktop-sign-sidecars] (skip missing) ${path.relative(root, d)}`);
  }
}

if (files.length === 0) {
  console.log("[desktop-sign-sidecars] no files found, nothing to sign");
  process.exit(0);
}

const { readFileSync } = await import("node:fs");
const binaries = [];
for (const f of files) {
  let buf;
  try {
    buf = readFileSync(f);
  } catch {
    continue;
  }
  if (isMachO(buf)) binaries.push(f);
}

console.log(
  `[desktop-sign-sidecars] ${binaries.length} Mach-O binaries across ${TARGET_DIRS.length} dirs`,
);

let signed = 0;
let preserved = 0;
let fail = 0;
for (const f of binaries) {
  // Ensure executable bit is set so codesign's runtime flag is meaningful.
  try {
    await chmod(f, 0o755);
  } catch {
    /* ignore */
  }
  if (signatureIsAcceptable(f)) {
    preserved++;
    continue;
  }
  if (codesignWithDeveloperId(f, identity)) signed++;
  else fail++;
}

console.log(
  `[desktop-sign-sidecars] preserved=${preserved} signed=${signed} failed=${fail} of ${binaries.length}`,
);

if (fail > 0) {
  console.error(`[desktop-sign-sidecars] ${fail} binaries failed to sign`);
  process.exit(1);
}

// Spot-check: confirm the bundled Node both remains signed and can execute JS.
const checks = [
  path.join(root, "desktop-server", "bin", "node"),
].filter((p) => {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
});
for (const c of checks) {
  const v = verifySignature(c);
  if (v.ok && v.hasRuntime && v.hasAuthority && v.hasTimestamp) {
    console.log(`[desktop-sign-sidecars] verified OK (runtime+timestamp+authority): ${path.relative(root, c)}`);
    assertNodeRuntimeWorks(c);
  } else {
    console.error(
      `[desktop-sign-sidecars] FAILED verification: ${path.relative(root, c)} ` +
        `ok=${v.ok} runtime=${v.hasRuntime} authority=${v.hasAuthority} timestamp=${v.hasTimestamp}`,
    );
    process.exit(1);
  }
}

console.log("[desktop-sign-sidecars] done");
