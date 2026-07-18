import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DESKTOP_BUILD_ENV_KEYS, loadLocalEnv } from "./lib/load-local-env.mjs";
import { createMacDmg, verifyMacDmg } from "./mac-dmg.mjs";

const require = createRequire(import.meta.url);
const tauriBin = require.resolve("@tauri-apps/cli/tauri.js");
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const nodeBinDir = dirname(process.execPath);
const localBinDir = join(appRoot, "node_modules", ".bin");
const pathWithCurrentNode = [nodeBinDir, localBinDir, process.env.PATH].filter(Boolean).join(delimiter);

loadLocalEnv({ cwd: appRoot, keys: DESKTOP_BUILD_ENV_KEYS });

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--") rawArgs.shift();
const forceUnsigned = rawArgs.includes("--local-unsigned");
const passthroughArgs = rawArgs.filter((arg) => arg !== "--local-unsigned");
const controlledFlags = ["--bundles", "--config", "--no-sign", "--target"];
for (const arg of passthroughArgs) {
  if (controlledFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
    throw new Error(`${arg} is controlled by scripts/desktop-build.mjs and cannot be overridden.`);
  }
}

const packageJson = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
const tauriConfig = JSON.parse(readFileSync(join(appRoot, "src-tauri", "tauri.conf.json"), "utf8"));
if (!packageJson.version || packageJson.version !== tauriConfig.version) {
  throw new Error(
    `package.json and tauri.conf.json versions must match (${packageJson.version} vs ${tauriConfig.version}).`,
  );
}

function commandOutput(result) {
  return `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`.trim();
}

function redactSecrets(value, secrets) {
  return secrets.reduce(
    (redacted, secret) => secret ? redacted.replaceAll(secret, "<redacted>") : redacted,
    value,
  );
}

function run(command, args, { capture = false, env = process.env, secrets = [] } = {}) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    shell: false,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
    env,
  });
  const output = redactSecrets(commandOutput(result), secrets);
  const displayArgs = args.map((arg) => secrets.includes(arg) ? "<redacted>" : arg);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${displayArgs.join(" ")} failed${output ? `: ${output}` : ""}`);
  }
  return output;
}

function buildEnvironment({ unsigned }) {
  const env = {
    ...process.env,
    PATH: pathWithCurrentNode,
  };
  if (!unsigned) return env;

  env.LUNERY_LOCAL_UNSIGNED_BUILD = "1";
  for (const key of [
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_API_KEY",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY_PATH",
  ]) {
    delete env[key];
  }
  return env;
}

function macReleaseCredentials() {
  const keys = ["APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
  if (forceUnsigned) return null;
  const supplied = keys.filter((key) => process.env[key]?.trim());
  if (supplied.length === 0) return null;
  const missing = keys.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Partial Apple release credentials are not allowed; missing ${missing.join(", ")}.`);
  }
  return {
    identity: process.env.APPLE_SIGNING_IDENTITY.trim(),
    appleId: process.env.APPLE_ID.trim(),
    password: process.env.APPLE_PASSWORD.trim(),
    teamId: process.env.APPLE_TEAM_ID.trim(),
  };
}

function runTauri(args, env) {
  run(process.execPath, [tauriBin, "build", ...args, ...passthroughArgs], { env });
}

function identityDetails(artifact) {
  return run("codesign", ["-dv", "--verbose=4", artifact], { capture: true });
}

function assertDeveloperIdSignature(artifact, identity, { deep = false } = {}) {
  const verifyArgs = ["--verify"];
  if (deep) verifyArgs.push("--deep", "--strict");
  verifyArgs.push("--verbose=2", artifact);
  run("codesign", verifyArgs);
  const details = identityDetails(artifact);
  if (!details.includes(`Authority=${identity}`)) {
    throw new Error(`Unexpected signing authority for ${artifact}; expected ${identity}.`);
  }
}

function notarize(artifact, credentials) {
  const args = [
    "notarytool",
    "submit",
    artifact,
    "--apple-id",
    credentials.appleId,
    "--password",
    credentials.password,
    "--team-id",
    credentials.teamId,
    "--wait",
  ];
  run("xcrun", args, { secrets: [credentials.password] });
}

function ensureAppNotarized(appPath, bundleRoot, credentials) {
  assertDeveloperIdSignature(appPath, credentials.identity, { deep: true });
  const validation = spawnSync("xcrun", ["stapler", "validate", appPath], {
    cwd: appRoot,
    shell: false,
    encoding: "utf8",
  });
  if (validation.status !== 0) {
    const archivePath = join(bundleRoot, ".Lunery-Lab-Studio-notary.zip");
    rmSync(archivePath, { force: true });
    try {
      run("ditto", ["-c", "-k", "--keepParent", appPath, archivePath]);
      notarize(archivePath, credentials);
      run("xcrun", ["stapler", "staple", appPath]);
    } finally {
      rmSync(archivePath, { force: true });
    }
  }
  run("xcrun", ["stapler", "validate", appPath]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
}

function signAndNotarizeDmg(dmgPath, credentials) {
  run("codesign", ["--force", "--timestamp", "--sign", credentials.identity, dmgPath]);
  notarize(dmgPath, credentials);
  run("xcrun", ["stapler", "staple", dmgPath]);
}

function verifyReleaseDmg(dmgPath, credentials) {
  assertDeveloperIdSignature(dmgPath, credentials.identity);
  run("spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=4",
    dmgPath,
  ]);
  run("xcrun", ["stapler", "validate", dmgPath]);
}

async function buildMac() {
  if (process.arch !== "arm64") {
    throw new Error(`The macOS installer is Apple Silicon only; found ${process.arch}.`);
  }
  const credentials = macReleaseCredentials();
  const unsigned = credentials === null;
  const env = buildEnvironment({ unsigned });
  console.log(`[desktop:build] macOS mode: ${unsigned ? "local unsigned" : "Developer ID release"}`);

  const tauriArgs = ["--bundles", "app"];
  if (unsigned) tauriArgs.push("--no-sign");
  runTauri(tauriArgs, env);

  const bundleRoot = join(appRoot, "src-tauri", "target", "release", "bundle");
  const appPath = join(bundleRoot, "macos", `${tauriConfig.productName}.app`);
  if (!existsSync(appPath)) throw new Error(`macOS app bundle was not produced: ${appPath}`);
  if (credentials) ensureAppNotarized(appPath, bundleRoot, credentials);

  const dmgPath = join(
    bundleRoot,
    "dmg",
    `${tauriConfig.productName}_${tauriConfig.version}_aarch64.dmg`,
  );
  createMacDmg({
    appPath,
    outputPath: dmgPath,
    volumeIconPath: join(appRoot, "src-tauri", "icons", "icon.icns"),
  });
  if (credentials) signAndNotarizeDmg(dmgPath, credentials);

  const evidencePath = process.env.LUNERY_DMG_LAYOUT_EVIDENCE
    ? resolve(appRoot, process.env.LUNERY_DMG_LAYOUT_EVIDENCE)
    : join(bundleRoot, "dmg", `${tauriConfig.productName}_${tauriConfig.version}_aarch64-layout.png`);
  await verifyMacDmg({
    dmgPath,
    appIconPath: join(appRoot, "src-tauri", "icons", "128x128@2x.png"),
    evidencePath,
  });
  if (credentials) verifyReleaseDmg(dmgPath, credentials);

  console.log("[desktop:build] macOS artifacts ready:");
  console.log(`  ${appPath}`);
  console.log(`  ${dmgPath}`);
  console.log(`  ${evidencePath}`);
}

function buildWindows() {
  console.log("[desktop:build] Windows mode: NSIS");
  runTauri(["--bundles", "nsis"], buildEnvironment({ unsigned: false }));
  const nsisRoot = join(appRoot, "src-tauri", "target", "release", "bundle", "nsis");
  const installers = existsSync(nsisRoot)
    ? readdirSync(nsisRoot).filter((name) => name.endsWith("-setup.exe"))
    : [];
  if (installers.length !== 1) {
    throw new Error(`Expected one NSIS installer in ${nsisRoot}; found ${installers.length}.`);
  }
  console.log(`[desktop:build] Windows installer ready: ${join(nsisRoot, installers[0])}`);
}

if (process.platform === "darwin") {
  await buildMac();
} else if (process.platform === "win32") {
  buildWindows();
} else {
  throw new Error(`Desktop packaging is supported on macOS and Windows; found ${process.platform}.`);
}
