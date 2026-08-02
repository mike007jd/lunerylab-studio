import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("does not retry an ambiguous transport failure", async () => {
    mocks.bridgeFetch.mockRejectedValue(new Error("connection reset"));
    const native = await import("@/lib/server/native-profile-fs");
    native.__nativeProfileFsTestHooks.sleep = vi.fn();

    await expect(native.nativeProfileMkdir("media", "generated")).rejects.toMatchObject({
      code: "safe_file_mutation_failed",
    });

    expect(mocks.bridgeFetch).toHaveBeenCalledTimes(1);
    expect(native.__nativeProfileFsTestHooks.sleep).not.toHaveBeenCalled();
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
});
