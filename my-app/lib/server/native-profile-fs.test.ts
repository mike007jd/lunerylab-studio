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
});
