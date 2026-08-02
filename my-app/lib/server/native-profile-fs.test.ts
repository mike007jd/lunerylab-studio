import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  bridgeFetch: vi.fn(),
  requireDesktopBridge: vi.fn(() => ({
    url: "http://127.0.0.1:43123",
    token: "test-token",
  })),
}));

vi.mock("@/lib/server/desktop-bridge", () => ({
  bridgeFetch: mocks.bridgeFetch,
  requireDesktopBridge: mocks.requireDesktopBridge,
}));

async function restoreIdentities(media: string, config: string) {
  const [mediaMetadata, configMetadata] = await Promise.all([
    fs.lstat(media, { bigint: true }),
    fs.lstat(config, { bigint: true }),
  ]);
  return {
    media: { device: mediaMetadata.dev.toString(), inode: mediaMetadata.ino.toString() },
    config: { device: configMetadata.dev.toString(), inode: configMetadata.ino.toString() },
  };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.resetModules();
  mocks.bridgeFetch.mockReset();
  mocks.requireDesktopBridge.mockClear();
});

afterEach(async () => {
  const native = await import("@/lib/server/native-profile-fs");
  native.__nativeProfileFsTestHooks.execute = null;
  native.__nativeProfileFsTestHooks.sleep = null;
  vi.unstubAllEnvs();
});

describe("native profile filesystem bridge admission", () => {
  it("retries a capacity rejection because the bridge has not executed the mutation", async () => {
    mocks.bridgeFetch
      .mockResolvedValueOnce(Response.json({ error: "at capacity" }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const native = await import("@/lib/server/native-profile-fs");
    const delays: number[] = [];
    native.__nativeProfileFsTestHooks.sleep = (delayMs) => {
      delays.push(delayMs);
    };

    await expect(native.nativeProfileMkdir("media", "generated")).resolves.toBeUndefined();

    expect(mocks.bridgeFetch).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([25]);
  });

  it("does not retry a mutation rejected after admission", async () => {
    mocks.bridgeFetch.mockResolvedValue(
      Response.json({ error: "destination exists" }, { status: 409 }),
    );
    const native = await import("@/lib/server/native-profile-fs");
    native.__nativeProfileFsTestHooks.sleep = vi.fn();

    await expect(native.nativeProfileMkdir("media", "generated")).rejects.toMatchObject({
      code: "safe_file_mutation_failed",
    });

    expect(mocks.bridgeFetch).toHaveBeenCalledTimes(1);
    expect(native.__nativeProfileFsTestHooks.sleep).not.toHaveBeenCalled();
  });

  it("retries an ambiguous mutation with the same native request id", async () => {
    mocks.bridgeFetch
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const native = await import("@/lib/server/native-profile-fs");
    const delays: number[] = [];
    native.__nativeProfileFsTestHooks.sleep = (delayMs) => {
      delays.push(delayMs);
    };

    await native.nativeProfileWrite(
      "media",
      "generated/result.webp",
      Buffer.from("result"),
      { replace: false },
    );

    expect(mocks.bridgeFetch).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([25]);
    const first = JSON.parse(String((mocks.bridgeFetch.mock.calls[0]?.[2] as RequestInit).body));
    const second = JSON.parse(String((mocks.bridgeFetch.mock.calls[1]?.[2] as RequestInit).body));
    expect(first.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.request_id).toBe(first.request_id);
  });

  it("retries an ambiguous mkdir transport failure because mkdir is idempotent", async () => {
    mocks.bridgeFetch
      .mockRejectedValueOnce(new Error("idle preconnect closed"))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const native = await import("@/lib/server/native-profile-fs");
    const delays: number[] = [];
    native.__nativeProfileFsTestHooks.sleep = (delayMs) => {
      delays.push(delayMs);
    };

    await expect(native.nativeProfileMkdir("media", "generated")).resolves.toBeUndefined();

    expect(mocks.bridgeFetch).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([25]);
  });

  it("forwards modification time in the external staged-file identity", async () => {
    mocks.bridgeFetch.mockResolvedValue(Response.json({ ok: true }));
    const native = await import("@/lib/server/native-profile-fs");

    await native.nativeUnlinkExternalIdentity("/tmp/.model.lunery-delete-token", {
      device: "11",
      inode: "22",
      sizeBytes: "33",
      modifiedAtNs: "44",
    });

    const request = mocks.bridgeFetch.mock.calls[0]?.[2] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      operation: "unlink-external-identity",
      expected_device: "11",
      expected_inode: "22",
      expected_size: "33",
      expected_modified_at_ns: "44",
    });
  });

  it("maps a native no-replace collision to EEXIST", async () => {
    mocks.bridgeFetch.mockResolvedValue(
      Response.json({ error: "Profile destination already exists" }, { status: 409 }),
    );
    const native = await import("@/lib/server/native-profile-fs");

    await expect(native.nativeProfileRename("models", "a.tmp", "a.json")).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("maps a native no-replace write collision to EEXIST", async () => {
    mocks.bridgeFetch.mockResolvedValue(
      Response.json({ error: "Profile destination already exists" }, { status: 409 }),
    );
    const native = await import("@/lib/server/native-profile-fs");

    await expect(native.nativeProfileWrite(
      "runtime",
      ".workspace-initialization.lock",
      Buffer.from("owner"),
      { replace: false },
    )).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("sends restore promotion as a token-only native operation", async () => {
    mocks.bridgeFetch.mockResolvedValue(Response.json({ ok: true }));
    const native = await import("@/lib/server/native-profile-fs");

    await native.nativePromoteWorkspaceRestoreRoots("restore-token-123");

    const request = mocks.bridgeFetch.mock.calls[0]?.[2] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      operation: "promote-workspace-restore-roots",
      token: "restore-token-123",
    });
    expect(JSON.parse(String(request.body))).not.toHaveProperty("root_path");
  });

  it("rejects hostile restore tokens and paths before bridge admission", async () => {
    const native = await import("@/lib/server/native-profile-fs");

    await expect(native.nativePrepareWorkspaceRestore("../../escape", {
      media: { device: "1", inode: "2" },
      config: { device: "3", inode: "4" },
    })).rejects.toThrow(
      "Invalid workspace restore token",
    );
    await expect(native.nativeWriteWorkspaceRestoreFile(
      "restore-token-123",
      "media",
      "../escape.txt",
      Buffer.from("escape"),
    )).rejects.toThrow("Invalid profile-relative path");
    expect(mocks.bridgeFetch).not.toHaveBeenCalled();
  });
});

describe("native profile filesystem restore test fallback", () => {
  it("rejects a replaced staging symlink without writing outside the profile", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const root = await fs.mkdtemp(path.join(tmpdir(), "lunery-native-restore-test-"));
    const outside = await fs.mkdtemp(path.join(tmpdir(), "lunery-native-restore-outside-"));
    const media = path.join(root, "media");
    const config = path.join(root, "config");
    await fs.mkdir(media);
    await fs.mkdir(config);
    vi.stubEnv("LUNERY_MEDIA_DIR", media);
    vi.stubEnv("LUNERY_CONFIG_DIR", config);
    vi.resetModules();
    const native = await import("@/lib/server/native-profile-fs");
    const token = "restore-symlink-token";
    await native.nativePrepareWorkspaceRestore(token, await restoreIdentities(media, config));
    const staged = path.join(root, `.media.restore-stage-${token}`);
    await fs.rename(staged, path.join(root, "held-stage"));
    await fs.symlink(outside, staged);

    await expect(native.nativeWriteWorkspaceRestoreFile(
      token,
      "media",
      "generated/escape.txt",
      Buffer.from("escape"),
    )).rejects.toThrow(/real directory|identity changed/i);
    await expect(fs.access(path.join(outside, "generated/escape.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await fs.rm(staged, { force: true });
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("rejects overlapping config and media roots before creating staging paths", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const root = await fs.mkdtemp(path.join(tmpdir(), "lunery-native-overlap-test-"));
    const config = path.join(root, "config");
    const media = path.join(config, "media");
    await fs.mkdir(media, { recursive: true });
    vi.stubEnv("LUNERY_CONFIG_DIR", config);
    vi.stubEnv("LUNERY_MEDIA_DIR", media);
    vi.resetModules();
    const native = await import("@/lib/server/native-profile-fs");
    const token = "restore-overlap-token";

    await expect(
      native.nativePrepareWorkspaceRestore(token, await restoreIdentities(media, config)),
    ).rejects.toThrow("must not overlap");
    await expect(
      fs.access(path.join(root, `.config.restore-stage-${token}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(config, `.media.restore-stage-${token}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects media=data before staging can include the database", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const root = await fs.mkdtemp(path.join(tmpdir(), "lunery-native-data-root-test-"));
    const data = path.join(root, "data");
    const config = path.join(root, "config");
    await fs.mkdir(path.join(data, "pglite"), { recursive: true });
    await fs.mkdir(config);
    vi.stubEnv("LUNERY_DATA_DIR", data);
    vi.stubEnv("LUNERY_MEDIA_DIR", data);
    vi.stubEnv("LUNERY_CONFIG_DIR", config);
    vi.resetModules();
    const native = await import("@/lib/server/native-profile-fs");
    const token = "restore-data-root-token";

    await expect(native.nativePrepareWorkspaceRestore(
      token,
      await restoreIdentities(data, config),
    )).rejects.toThrow(
      "protected profile resource",
    );
    await expect(
      fs.access(path.join(root, `.data.restore-stage-${token}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("retains staging authority through promotion until cleanup succeeds", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const root = await fs.mkdtemp(path.join(tmpdir(), "lunery-native-authority-test-"));
    const media = path.join(root, "media");
    const config = path.join(root, "config");
    await fs.mkdir(media);
    await fs.mkdir(config);
    vi.stubEnv("LUNERY_MEDIA_DIR", media);
    vi.stubEnv("LUNERY_CONFIG_DIR", config);
    vi.resetModules();
    const native = await import("@/lib/server/native-profile-fs");
    const originals = await restoreIdentities(media, config);
    await native.nativePrepareWorkspaceRestore("restore-authority-one", originals);
    const staged = await restoreIdentities(
      path.join(root, ".media.restore-stage-restore-authority-one"),
      path.join(root, ".config.restore-stage-restore-authority-one"),
    );
    await native.nativeAttestWorkspaceRestoreStages("restore-authority-one", staged);
    await native.nativePromoteWorkspaceRestoreRoots("restore-authority-one");

    await expect(native.nativePrepareWorkspaceRestore(
      "restore-authority-two",
      await restoreIdentities(media, config),
    )).rejects.toThrow("Another workspace restore staging authority is active");

    await native.nativeCleanupWorkspaceRestore("restore-authority-one", originals, staged);
    const current = await restoreIdentities(media, config);
    await native.nativePrepareWorkspaceRestore("restore-authority-two", current);
    await native.nativeRollbackWorkspaceRestoreRoots("restore-authority-two", current, null);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("resumes cold rollback after a placeholder was already moved to discarded", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const root = await fs.mkdtemp(path.join(tmpdir(), "lunery-native-rollback-resume-test-"));
    const media = path.join(root, "media");
    const config = path.join(root, "config");
    await fs.mkdir(media);
    await fs.mkdir(config);
    await fs.writeFile(path.join(media, "old.txt"), "old-media");
    vi.stubEnv("LUNERY_MEDIA_DIR", media);
    vi.stubEnv("LUNERY_CONFIG_DIR", config);
    vi.resetModules();
    const native = await import("@/lib/server/native-profile-fs");
    const token = "restore-placeholder-resume";
    const originals = await restoreIdentities(media, config);
    await native.nativePrepareWorkspaceRestore(token, originals);
    const mediaStage = path.join(root, `.media.restore-stage-${token}`);
    const configStage = path.join(root, `.config.restore-stage-${token}`);
    const previous = path.join(root, `.media.restore-previous-${token}`);
    const discarded = path.join(root, `.media.restore-discarded-${token}`);
    const staged = await restoreIdentities(mediaStage, configStage);
    await native.nativeAttestWorkspaceRestoreStages(token, staged);
    await fs.rename(media, previous);
    await fs.mkdir(media);
    await fs.rename(media, discarded);
    await fs.mkdir(media);
    native.resetNativeProfileFsRestoreForTests();

    await native.nativeRollbackWorkspaceRestoreRoots(token, originals, staged);

    expect(await fs.readFile(path.join(media, "old.txt"), "utf8")).toBe("old-media");
    for (const residue of [mediaStage, configStage, previous, discarded]) {
      await expect(fs.access(residue)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await fs.rm(root, { recursive: true, force: true });
  });
});
