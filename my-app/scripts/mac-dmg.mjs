import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DMGBUILD_VERSION = "1.6.7";
export const DMGBUILD_WHEEL_SHA256 = "37ee5771c377beb3203d9164aae8046ffed8531c06edf9227f5788b3c599b1bf";

export const DMG_LAYOUT = Object.freeze({
  width: 660,
  height: 400,
  iconSize: 128,
  appLocation: Object.freeze([180, 170]),
  applicationsLocation: Object.freeze([480, 170]),
});

const APP_BUNDLE_NAME = "Lunery Lab Studio.app";
const DMGBUILD_WHEEL_NAME = `dmgbuild-${DMGBUILD_VERSION}-py3-none-any.whl`;
const DMGBUILD_WHEEL_URL = `https://files.pythonhosted.org/packages/6c/4a/8812638bba991a55a4b670806ab9cf60207077401893bb308eb1b04f288c/${DMGBUILD_WHEEL_NAME}`;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.join(scriptDir, "dmgbuild-settings.py");
const toolRoot = path.join(
  homedir(),
  "Library",
  "Caches",
  "LuneryLab",
  "build-tools",
  `dmgbuild-${DMGBUILD_VERSION}`,
);
const toolPython = path.join(toolRoot, "bin", "python");
const toolExecutable = path.join(toolRoot, "bin", "dmgbuild");
const integrityMarker = path.join(toolRoot, ".dmgbuild-wheel-sha256");
const wheelPath = path.join(path.dirname(toolRoot), "downloads", DMGBUILD_WHEEL_NAME);

function commandOutput(result) {
  return `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`.trim();
}

function run(command, args, { capture = false, input } = {}) {
  const result = spawnSync(command, args, {
    shell: false,
    stdio: capture ? "pipe" : "inherit",
    encoding: capture ? "utf8" : undefined,
    input,
  });
  const output = commandOutput(result);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed${output ? `: ${output}` : ""}`);
  }
  return output;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function installedDmgbuildVersion() {
  if (!existsSync(toolPython)) return null;
  const result = spawnSync(
    toolPython,
    ["-c", 'from importlib.metadata import version; print(version("dmgbuild"))'],
    { encoding: "utf8", shell: false },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function ensureVerifiedWheel() {
  if (existsSync(wheelPath) && sha256(wheelPath) === DMGBUILD_WHEEL_SHA256) return wheelPath;

  mkdirSync(path.dirname(wheelPath), { recursive: true });
  const temporaryPath = `${wheelPath}.download`;
  rmSync(temporaryPath, { force: true });
  run("curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--output",
    temporaryPath,
    DMGBUILD_WHEEL_URL,
  ]);
  const actualSha256 = sha256(temporaryPath);
  if (actualSha256 !== DMGBUILD_WHEEL_SHA256) {
    rmSync(temporaryPath, { force: true });
    throw new Error(`dmgbuild wheel SHA256 mismatch: expected ${DMGBUILD_WHEEL_SHA256}, got ${actualSha256}`);
  }
  renameSync(temporaryPath, wheelPath);
  return wheelPath;
}

function ensureDmgbuild() {
  if (process.platform !== "darwin") {
    throw new Error("Lunery Lab Studio DMG packaging requires macOS.");
  }
  const installedIntegrity = existsSync(integrityMarker)
    ? readFileSync(integrityMarker, "utf8").trim()
    : null;
  if (
    installedDmgbuildVersion() === DMGBUILD_VERSION
    && installedIntegrity === DMGBUILD_WHEEL_SHA256
    && existsSync(toolExecutable)
  ) {
    return { executable: toolExecutable, python: toolPython };
  }

  const pythonVersion = run(
    "python3",
    ["-c", 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'],
    { capture: true },
  );
  const [major, minor] = pythonVersion.split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 10)) {
    throw new Error(`dmgbuild ${DMGBUILD_VERSION} requires Python >=3.10; found ${pythonVersion}.`);
  }

  rmSync(toolRoot, { recursive: true, force: true });
  mkdirSync(path.dirname(toolRoot), { recursive: true });
  const verifiedWheel = ensureVerifiedWheel();
  console.log(`[dmg] installing SHA256-verified dmgbuild ${DMGBUILD_VERSION} with Python ${pythonVersion}...`);
  run("python3", ["-m", "venv", toolRoot]);
  run(toolPython, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--only-binary=:all:",
    verifiedWheel,
  ]);
  if (installedDmgbuildVersion() !== DMGBUILD_VERSION || !existsSync(toolExecutable)) {
    throw new Error(`Pinned dmgbuild ${DMGBUILD_VERSION} installation is incomplete: ${toolRoot}`);
  }
  writeFileSync(integrityMarker, `${DMGBUILD_WHEEL_SHA256}\n`, { mode: 0o600 });
  return { executable: toolExecutable, python: toolPython };
}

function readMountedLayout(python, mountPath) {
  const dsStorePath = path.join(mountPath, ".DS_Store");
  const source = [
    "import json, sys",
    "from ds_store import DSStore",
    "with DSStore.open(sys.argv[1], 'r') as store:",
    "    values = {name: list(store[name]['Iloc']) for name in sys.argv[2:]}",
    "print(json.dumps(values, sort_keys=True))",
  ].join("\n");
  return JSON.parse(run(
    python,
    ["-c", source, dsStorePath, APP_BUNDLE_NAME, "Applications"],
    { capture: true },
  ));
}

function assertLocation(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== 2 || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} icon location must be ${expected.join(",")}; found ${JSON.stringify(actual)}.`);
  }
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function renderLayoutEvidence({ backgroundPath, appIconPath, evidencePath }) {
  if (!evidencePath) return;
  if (!existsSync(appIconPath)) throw new Error(`DMG evidence app icon is missing: ${appIconPath}`);

  const { default: sharp } = await import("sharp");
  const appIcon = await sharp(appIconPath)
    .resize(DMG_LAYOUT.iconSize, DMG_LAYOUT.iconSize, { fit: "contain" })
    .png()
    .toBuffer();
  const applicationsIcon = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <defs><linearGradient id="folder" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#74b7ff"/><stop offset="1" stop-color="#2675d8"/></linearGradient></defs>
      <path d="M10 31c0-8 6-14 14-14h28l10 12h42c8 0 14 6 14 14v59c0 8-6 14-14 14H24c-8 0-14-6-14-14z" fill="url(#folder)" stroke="#d7ecff" stroke-width="3"/>
      <path d="M42 91l22-39 22 39M51 76h26" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `);
  const labels = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${DMG_LAYOUT.width}" height="${DMG_LAYOUT.height}">
      <style>.label{font:600 16px -apple-system,BlinkMacSystemFont,sans-serif;fill:#1d1d1f;paint-order:stroke;stroke:#fff;stroke-width:4px;stroke-linejoin:round}</style>
      <text class="label" x="${DMG_LAYOUT.appLocation[0]}" y="270" text-anchor="middle">${xmlEscape(APP_BUNDLE_NAME.slice(0, -4))}</text>
      <text class="label" x="${DMG_LAYOUT.applicationsLocation[0]}" y="270" text-anchor="middle">Applications</text>
    </svg>
  `);
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  await sharp(backgroundPath)
    .resize(DMG_LAYOUT.width, DMG_LAYOUT.height, { fit: "fill" })
    .composite([
      {
        input: appIcon,
        left: DMG_LAYOUT.appLocation[0] - DMG_LAYOUT.iconSize / 2,
        top: DMG_LAYOUT.appLocation[1] - DMG_LAYOUT.iconSize / 2,
      },
      {
        input: applicationsIcon,
        left: DMG_LAYOUT.applicationsLocation[0] - DMG_LAYOUT.iconSize / 2,
        top: DMG_LAYOUT.applicationsLocation[1] - DMG_LAYOUT.iconSize / 2,
      },
      { input: labels, left: 0, top: 0 },
    ])
    .png()
    .toFile(evidencePath);
  console.log(`[dmg] saved headless layout evidence: ${evidencePath}`);
}

export function createMacDmg({ appPath, outputPath, volumeIconPath }) {
  if (!existsSync(appPath)) throw new Error(`DMG source app is missing: ${appPath}`);
  if (path.basename(appPath) !== APP_BUNDLE_NAME) {
    throw new Error(`DMG source must be ${APP_BUNDLE_NAME}, found ${path.basename(appPath)}.`);
  }
  if (!existsSync(volumeIconPath)) throw new Error(`DMG volume icon is missing: ${volumeIconPath}`);
  if (!existsSync(settingsPath)) throw new Error(`DMG settings are missing: ${settingsPath}`);

  const { executable } = ensureDmgbuild();
  mkdirSync(path.dirname(outputPath), { recursive: true });
  rmSync(outputPath, { force: true });
  const temporaryPath = `${outputPath}.tmp.dmg`;
  rmSync(temporaryPath, { force: true });

  console.log("[dmg] creating the 660x400 headless drag-install layout...");
  run(executable, [
    "-s", settingsPath,
    "-D", `app_path=${appPath}`,
    "-D", `volume_icon=${volumeIconPath}`,
    "Lunery Lab Studio",
    temporaryPath,
  ]);
  if (!existsSync(temporaryPath)) throw new Error(`dmgbuild did not produce ${temporaryPath}`);
  renameSync(temporaryPath, outputPath);
  console.log(`[dmg] wrote ${outputPath}`);
}

export async function verifyMacDmg({ dmgPath, appIconPath, evidencePath }) {
  if (!existsSync(dmgPath)) throw new Error(`DMG is missing: ${dmgPath}`);
  const { python } = ensureDmgbuild();
  run("hdiutil", ["verify", dmgPath]);

  const attachPlist = run(
    "hdiutil",
    ["attach", "-readonly", "-nobrowse", "-noautoopen", "-plist", dmgPath],
    { capture: true },
  );
  let mountPath;
  let verificationError;
  try {
    const plistJson = run(
      "plutil",
      ["-convert", "json", "-o", "-", "--", "-"],
      { capture: true, input: attachPlist },
    );
    const entities = JSON.parse(plistJson)["system-entities"] ?? [];
    mountPath = entities.find((entry) => entry["mount-point"])?.["mount-point"];
    if (!mountPath) throw new Error("Mounted DMG did not report a mount point.");

    const mountedAppPath = path.join(mountPath, APP_BUNDLE_NAME);
    const applicationsPath = path.join(mountPath, "Applications");
    const backgroundPath = path.join(mountPath, ".background.tiff");
    if (!existsSync(mountedAppPath)) throw new Error(`Mounted DMG is missing ${APP_BUNDLE_NAME}.`);
    if (!lstatSync(applicationsPath).isSymbolicLink() || readlinkSync(applicationsPath) !== "/Applications") {
      throw new Error("Mounted DMG Applications entry must be a symlink to /Applications.");
    }
    if (!existsSync(backgroundPath)) throw new Error("Mounted DMG is missing its drag-arrow background.");

    const locations = readMountedLayout(python, mountPath);
    assertLocation(locations[APP_BUNDLE_NAME], DMG_LAYOUT.appLocation, APP_BUNDLE_NAME);
    assertLocation(locations.Applications, DMG_LAYOUT.applicationsLocation, "Applications");
    await renderLayoutEvidence({ backgroundPath, appIconPath, evidencePath });
    console.log(`[dmg] verified mounted contents and fixed icon locations in ${mountPath}`);
  } catch (error) {
    verificationError = error;
  } finally {
    if (mountPath) {
      const detach = spawnSync("hdiutil", ["detach", mountPath], { encoding: "utf8", shell: false });
      if (detach.status !== 0 && !verificationError) {
        verificationError = new Error(`Unable to detach ${mountPath}: ${commandOutput(detach)}`);
      }
    }
  }
  if (verificationError) throw verificationError;
}
