import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("desktop installer packaging", () => {
  it("routes each platform through one controlled packaging entrypoint", () => {
    const packageJson = JSON.parse(source("package.json"));
    const tauri = JSON.parse(source("src-tauri/tauri.conf.json"));
    const build = source("scripts/desktop-build.mjs");
    const localBuild = source("scripts/desktop-build-local.mjs");

    expect(packageJson.scripts["desktop:build"]).toBe("node scripts/desktop-build.mjs");
    expect(packageJson.scripts["desktop:build:local"]).toBe("node scripts/desktop-build-local.mjs");
    expect(tauri.bundle.targets).toEqual(["app"]);
    expect(build).toContain('runTauri(["--bundles", "nsis"]');
    expect(build).toContain('const tauriArgs = ["--bundles", "app"]');
    expect(build).toContain("createMacDmg");
    expect(build).toContain("verifyMacDmg");
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
    expect(settings).toContain("background = 'builtin-arrow'");
    expect(settings).toContain("window_rect = ((200, 120), (660, 400))");
    expect(settings).toContain("'Lunery Lab Studio.app': (180, 170)");
    expect(settings).toContain("'Applications': (480, 170)");
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

  it("keeps packaged startup failures private and retryable", () => {
    const bundleAssets = source("scripts/desktop-bundle-assets.mjs");
    const tauriSource = source("src-tauri/src/lib.rs");
    const tauriConfig = JSON.parse(source("src-tauri/tauri.conf.json"));

    expect(tauriConfig.app.windows[0].visible).toBe(false);
    expect(tauriSource).toContain("boot_desktop_runtime(startup_app, startup_download_state)");
    expect(tauriSource).toContain('navigate_and_show(app, "tauri://localhost/error.html")');
    expect(tauriSource).toContain("probe_desktop_health(port, expected_session_hash)");
    expect(bundleAssets).toContain('await invoke("retry_desktop_runtime")');
    expect(bundleAssets).toContain("Technical details were saved in the Lunery Logs folder.");
    expect(bundleAssets).not.toContain("String(error)");
    expect(bundleAssets).not.toContain("Could not start local Studio runtime:");
  });

  it("recovers an incompatible prelaunch database without blocking the window", () => {
    const runtime = source("scripts/desktop-runtime-server.mjs");

    expect(runtime).toContain("class IncompatibleDesktopDatabaseError extends Error");
    expect(runtime).toContain("archiveIncompatibleDatabase(dataRoot)");
    expect(runtime).toContain('path.join(path.dirname(dataRoot), "recovery")');
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
    expect(workflow).toContain("runner: [self-hosted, macOS, ARM64, ecommerceai]");
    expect(workflow).not.toContain("APPLE_CERTIFICATE");
    expect(validateWorkflow).toContain(
      "runs-on: [self-hosted, macOS, ARM64, ecommerceai]",
    );
    expect(validateWorkflow).toContain("pnpm verify");
    expect(validateWorkflow).toContain("corepack pnpm@11.13.1 --pm-on-fail=ignore audit");
    expect(validateWorkflow).toContain("pnpm desktop:check");
    expect(validateWorkflow).not.toContain("cache: pnpm");
    expect(workflow).not.toContain("tauri-apps/tauri-action");
    expect(controlledSources).not.toMatch(/\bosascript\b|tell application|set bounds of window/i);
  });
});
