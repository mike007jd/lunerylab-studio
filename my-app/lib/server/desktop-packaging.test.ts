import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("desktop installer packaging", () => {
  it("keeps the desktop icon transparent outside its rounded silhouette", async () => {
    for (const path of [
      "src-tauri/icons/icon-source.png",
      "src-tauri/icons/icon.png",
      "src-tauri/icons/128x128@2x.png",
      "src-tauri/icons/128x128.png",
      "src-tauri/icons/32x32.png",
    ]) {
      const { data, info } = await sharp(join(process.cwd(), path))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];

      expect(alphaAt(0, 0), `${path} top-left corner`).toBe(0);
      expect(alphaAt(info.width - 1, 0), `${path} top-right corner`).toBe(0);
      expect(alphaAt(0, info.height - 1), `${path} bottom-left corner`).toBe(0);
      expect(
        alphaAt(info.width - 1, info.height - 1),
        `${path} bottom-right corner`,
      ).toBe(0);
      expect(
        alphaAt(Math.floor(info.width / 2), Math.floor(info.height / 2)),
        `${path} center`,
      ).toBe(255);
    }
  });

  it("keeps the supported release target on one controlled packaging entrypoint", () => {
    const packageJson = JSON.parse(source("package.json"));
    const tauri = JSON.parse(source("src-tauri/tauri.conf.json"));
    const build = source("scripts/desktop-build.mjs");
    const localBuild = source("scripts/desktop-build-local.mjs");

    expect(packageJson.scripts["desktop:build"]).toBe("node scripts/desktop-build.mjs");
    expect(packageJson.scripts["desktop:build:local"]).toBe("node scripts/desktop-build-local.mjs");
    expect(tauri.bundle.targets).toEqual(["app"]);
    expect(build).toContain('const tauriArgs = ["--bundles", "app"]');
    expect(build).toContain("createMacDmg");
    expect(build).toContain("verifyMacDmg");
    expect(build).toContain("currently supported only on macOS");
    expect(build).not.toContain('"--bundles", "nsis"');
    expect(localBuild).toContain('"--local-unsigned"');
  });

  it("uses the pinned headless DMG builder and verifies the mounted layout", () => {
    const dmg = source("scripts/mac-dmg.mjs");
    const settings = source("scripts/dmgbuild-settings.py");

    expect(dmg).toContain('DMGBUILD_VERSION = "1.6.7"');
    expect(dmg).toContain(
      'DMGBUILD_WHEEL_SHA256 = "37ee5771c377beb3203d9164aae8046ffed8531c06edf9227f5788b3c599b1bf"',
    );
    expect(dmg).toContain("files.pythonhosted.org");
    expect(dmg).toContain("dmgbuild wheel SHA256 mismatch");
    expect(dmg).toContain('["attach", "-readonly", "-nobrowse", "-noautoopen", "-plist", dmgPath]');
    expect(dmg).toContain('readlinkSync(applicationsPath) !== "/Applications"');
    expect(dmg).toContain('run("hdiutil", ["verify", dmgPath])');
    expect(dmg).toContain('["--verify", "--deep", "--strict", "--verbose=2", appPath]');
    expect(settings).toContain("background = 'builtin-arrow'");
    expect(settings).toContain("window_rect = ((200, 120), (660, 400))");
    expect(settings).toContain("'Lunery Lab Studio.app': (180, 170)");
    expect(settings).toContain("'Applications': (480, 170)");
    expect(settings).not.toContain("hide_extensions");
  });

  it("keeps release signing and notarization in the required artifact order", () => {
    const build = source("scripts/desktop-build.mjs");
    const appIndex = build.indexOf("ensureAppNotarized(appPath, bundleRoot, credentials)");
    const createDmgIndex = build.indexOf("createMacDmg({");
    const signDmgIndex = build.indexOf("if (credentials) signAndNotarizeDmg(dmgPath, credentials)");
    const verifyDmgIndex = build.indexOf("await verifyMacDmg({");
    const releaseGateIndex = build.indexOf("if (credentials) verifyReleaseDmg(dmgPath, credentials)");

    expect(appIndex).toBeGreaterThan(-1);
    expect(createDmgIndex).toBeGreaterThan(appIndex);
    expect(signDmgIndex).toBeGreaterThan(createDmgIndex);
    expect(verifyDmgIndex).toBeGreaterThan(signDmgIndex);
    expect(releaseGateIndex).toBeGreaterThan(verifyDmgIndex);
    expect(build).toContain("redactSecrets(commandOutput(result), secrets)");
    expect(build).toContain("{ secrets: [credentials.password] }");
  });

  it("keeps packaged startup failures private, retryable, and user-resettable", () => {
    const bundleAssets = source("scripts/desktop-bundle-assets.mjs");
    const tauriSource = source("src-tauri/src/lib.rs");
    const tauriConfig = JSON.parse(source("src-tauri/tauri.conf.json"));

    expect(tauriConfig.app.windows[0].visible).toBe(false);
    expect(tauriSource).toContain(
      "schedule_desktop_runtime_boot(startup_app, startup_download_state)",
    );
    expect(tauriSource).toContain('spawn_lifecycle_task("lunery-desktop-boot"');
    expect(tauriSource).toContain('navigate_and_show(app, "tauri://localhost/error.html")');
    expect(tauriSource).toContain("probe_desktop_health(port, expected_session_hash)");
    expect(bundleAssets).toContain('await invoke("retry_desktop_runtime")');
    expect(bundleAssets).toContain('await invoke("reset_desktop_workspace"');
    expect(bundleAssets).toContain('const DESKTOP_WORKSPACE_RESET_CONFIRMATION = "DELETE_LUNERY_WORKSPACE"');
    expect(bundleAssets).toContain("confirmation: DESKTOP_WORKSPACE_RESET_CONFIRMATION");
    expect(bundleAssets).toContain('await invoke("open_desktop_profile_folder")');
    expect(bundleAssets).toContain("Delete workspace data");
    expect(bundleAssets).toContain("Projects, canvases, media files, and recovery copies");
    expect(bundleAssets).toContain("Models and service connections stay on this computer.");
    expect(bundleAssets).toContain("RETRY_TIMEOUT_MS = 35_000");
    expect(bundleAssets).toContain('<script type="module" src="./error.js"></script>');
    expect(bundleAssets).toContain('writeFile(path.join(distOut, "error.js"), errorScript');
    expect(bundleAssets).not.toContain('<script type="module">');
    expect(bundleAssets).toContain("Technical details were saved in the Lunery Logs folder.");
    expect(bundleAssets).not.toContain("String(error)");
    expect(bundleAssets).not.toContain("Could not start local Studio runtime:");
  });

  it("recovers an incompatible prelaunch database without blocking the window", () => {
    const runtime = source("scripts/desktop-runtime-server.mjs");
    const migrations = source("scripts/desktop-pglite-migrations.mjs");

    expect(migrations).toContain("class IncompatibleDesktopDatabaseError extends Error");
    expect(migrations).toContain("archiveIncompatibleDatabase(dataRoot)");
    expect(migrations).toContain('path.join(path.dirname(dataRoot), "recovery")');
    expect(migrations).toContain("await db.transaction(async (tx) =>");
    expect(runtime).toContain('from "./desktop-pglite-migrations.mjs"');
    const bundleAssets = source("scripts/desktop-bundle-assets.mjs");
    expect(bundleAssets).toContain('path.join(root, "scripts", "desktop-pglite-migrations.mjs")');
    expect(bundleAssets).toContain('path.join(appOut, "desktop-pglite-migrations.mjs")');
    expect(runtime).toContain("const db = await openDesktopDatabase(dataRoot, migrationsDir)");
    expect(runtime).toContain('process.env.LUNERY_PARENT_PID || "0"');
    expect(runtime).not.toContain("idleTimeout:");
  });

  it("uses the repository wrapper in CI without GUI layout automation", () => {
    const workflow = source("../.github/workflows/desktop-release.yml");
    const validateWorkflow = source("../.github/workflows/validate.yml");
    const controlledSources = [
      workflow,
      validateWorkflow,
      source("scripts/desktop-build.mjs"),
      source("scripts/desktop-build-local.mjs"),
      source("scripts/mac-dmg.mjs"),
    ].join("\n");

    expect(workflow).toContain("run: pnpm desktop:build");
    expect(workflow).toContain("runner: macos-latest");
    expect(workflow).not.toContain("runner: windows-latest");
    expect(workflow).not.toContain("Lunery-Lab-Studio-Windows-x64.exe");
    // Hosted runners import the Developer ID certificate into an ephemeral
    // keychain under RUNNER_TEMP and delete the decoded .p12 before building.
    expect(workflow).toContain("Import Apple Developer certificate into a temporary keychain");
    expect(workflow).toContain('security create-keychain -p "$keychain_password" "$keychain"');
    expect(workflow).toContain('rm -f "$RUNNER_TEMP/certificate.p12"');
    expect(validateWorkflow).toContain(
      "runs-on: macos-latest",
    );
    expect(validateWorkflow).toContain("pnpm verify");
    expect(validateWorkflow).toContain("corepack pnpm@11.13.1 --pm-on-fail=ignore audit");
    expect(validateWorkflow).toContain("pnpm desktop:check");
    expect(validateWorkflow).toContain("cache: pnpm");
    expect(workflow).not.toContain("tauri-apps/tauri-action");
    expect(controlledSources).not.toMatch(/\bosascript\b|tell application|set bounds of window/i);
  });
});
