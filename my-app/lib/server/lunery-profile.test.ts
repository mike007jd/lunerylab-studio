import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";

describe("lunery-profile", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults desktop-owned data under the visible Lunery profile", async () => {
    const home = path.join(os.tmpdir(), "lunery-profile-home");
    vi.stubEnv("HOME", home);
    vi.resetModules();

    const profile = await import("@/lib/server/lunery-profile");
    expect(profile.luneryProfileRoot()).toBe(path.join(home, ".lunerylab", "studio"));
    expect(profile.luneryConfigDir()).toBe(path.join(home, ".lunerylab", "studio", "config"));
    expect(profile.luneryPgliteDir()).toBe(path.join(home, ".lunerylab", "studio", "data", "pglite"));
    expect(profile.luneryMediaDir()).toBe(path.join(home, ".lunerylab", "studio", "data", "media"));
    expect(profile.luneryModelsDir()).toBe(path.join(home, ".lunerylab", "studio", "models"));
  });

  it("honors absolute profile overrides and rejects relative ones", async () => {
    const root = path.join(os.tmpdir(), "lunery-profile-root");
    vi.stubEnv("LUNERY_HOME", root);
    vi.resetModules();

    const profile = await import("@/lib/server/lunery-profile");
    expect(profile.luneryProfileRoot()).toBe(root);

    vi.stubEnv("LUNERY_HOME", "relative-profile");
    vi.resetModules();
    const reloaded = await import("@/lib/server/lunery-profile");
    expect(() => reloaded.luneryProfileRoot()).toThrow(/absolute path/);
  });
});
