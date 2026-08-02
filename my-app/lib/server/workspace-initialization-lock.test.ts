import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("@/lib/server/native-profile-fs", () => ({
  nativeProfileWrite: mocks.write,
  nativeProfileUnlink: mocks.unlink,
}));

import {
  __workspaceInitializationLockTestHooks,
  withWorkspaceInitializationLock,
} from "@/lib/server/workspace-initialization-lock";

function collision(): NodeJS.ErrnoException {
  const error = new Error("destination exists") as NodeJS.ErrnoException;
  error.code = "EEXIST";
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  __workspaceInitializationLockTestHooks.now = null;
  __workspaceInitializationLockTestHooks.sleep = null;
});

afterEach(() => {
  __workspaceInitializationLockTestHooks.now = null;
  __workspaceInitializationLockTestHooks.sleep = null;
});

describe("workspace initialization lock", () => {
  it("serializes separately initiated first-boot work", async () => {
    let locked = false;
    const firstWork = { release: null as null | (() => void) };
    const order: string[] = [];
    mocks.write.mockImplementation(async () => {
      if (locked) throw collision();
      locked = true;
    });
    mocks.unlink.mockImplementation(async () => {
      locked = false;
    });

    const first = withWorkspaceInitializationLock(async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        firstWork.release = resolve;
      });
      order.push("first-end");
    });
    await vi.waitFor(() => expect(order).toEqual(["first-start"]));

    const second = withWorkspaceInitializationLock(async () => {
      order.push("second");
    });
    await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
    firstWork.release?.();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
  });

  it("releases the lock when initialization fails", async () => {
    mocks.write.mockResolvedValue(undefined);
    mocks.unlink.mockResolvedValue(undefined);

    await expect(withWorkspaceInitializationLock(async () => {
      throw new Error("bootstrap failed");
    })).rejects.toThrow("bootstrap failed");

    expect(mocks.unlink).toHaveBeenCalledWith(
      "runtime",
      ".workspace-initialization.lock",
      { missingOk: false },
    );
  });

  it("does not retry failures other than a lock collision", async () => {
    mocks.write.mockRejectedValue(new Error("native service unavailable"));

    await expect(withWorkspaceInitializationLock(async () => undefined))
      .rejects.toThrow("native service unavailable");

    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
});
