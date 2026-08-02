import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  beginDetachedVideoWork,
  getWorkspaceExclusiveCapability,
  getWorkspaceOperationGateStateForTests,
  resetWorkspaceOperationGateForTests,
  runWithDetachedVideoAdmission,
  withSharedMutationLease,
  withWorkspaceExclusive,
} from "@/lib/server/workspace-operation-gate";
import { ApiError } from "@/lib/server/errors";

describe("workspace mutation lease", () => {
  beforeEach(() => {
    resetWorkspaceOperationGateForTests();
  });

  afterEach(() => {
    resetWorkspaceOperationGateForTests();
  });

  it("lets exclusive drain an in-flight shared writer before starting", async () => {
    let releaseShared!: () => void;
    const sharedStarted = new Promise<void>((resolve) => {
      void withSharedMutationLease(async () => {
        resolve();
        await new Promise<void>((hold) => {
          releaseShared = hold;
        });
      });
    });
    await sharedStarted;
    expect(getWorkspaceOperationGateStateForTests().sharedCount).toBe(1);

    let exclusiveEntered = false;
    const exclusivePromise = withWorkspaceExclusive("backup", async () => {
      exclusiveEntered = true;
      expect(getWorkspaceOperationGateStateForTests().sharedCount).toBe(0);
      expect(getWorkspaceExclusiveCapability()?.operation).toBe("backup");
    });

    await Promise.resolve();
    expect(exclusiveEntered).toBe(false);
    expect(getWorkspaceOperationGateStateForTests().exclusivePending).toBe(true);

    releaseShared();
    await exclusivePromise;
    expect(exclusiveEntered).toBe(true);
    expect(getWorkspaceOperationGateStateForTests()).toMatchObject({
      exclusive: null,
      exclusivePending: false,
      sharedCount: 0,
    });
  });

  it("rejects external shared writers while exclusive is held", async () => {
    await withWorkspaceExclusive("restore", async () => {
      // Nested shared under exclusive authority is re-entrant (restore internals).
      await expect(withSharedMutationLease(async () => "nested-ok")).resolves.toBe("nested-ok");
      // Fresh video admission from outside the exclusive ALS must still fail.
      expect(() => beginDetachedVideoWork()).toThrow(ApiError);
    });
    await expect(withSharedMutationLease(async () => "after")).resolves.toBe("after");
  });

  it("rejects a concurrent shared writer started outside exclusive ownership", async () => {
    let releaseExclusive!: () => void;
    const exclusiveReady = new Promise<void>((resolve) => {
      void withWorkspaceExclusive("backup", async () => {
        resolve();
        await new Promise<void>((hold) => {
          releaseExclusive = hold;
        });
      });
    });
    await exclusiveReady;
    await expect(withSharedMutationLease(async () => "nope")).rejects.toMatchObject({
      status: 409,
      code: "workspace_busy",
    });
    releaseExclusive();
  });

  it("invalidates shared authority inherited by async work after the lease releases", async () => {
    let startDerived!: () => void;
    let derivedMutation!: Promise<string>;
    await withSharedMutationLease(async () => {
      const start = new Promise<void>((resolve) => {
        startDerived = resolve;
      });
      // Promise callbacks inherit the current ALS store even when they run
      // after this parent work has returned. The shared token must expire.
      derivedMutation = start.then(() =>
        withSharedMutationLease(async () => "must-not-run"),
      );
    });

    let releaseExclusive!: () => void;
    let exclusiveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      exclusiveReady = resolve;
    });
    const exclusive = withWorkspaceExclusive("backup", async () => {
      exclusiveReady();
      await new Promise<void>((resolve) => {
        releaseExclusive = resolve;
      });
    });
    await ready;

    startDerived();
    await expect(derivedMutation).rejects.toMatchObject({
      status: 409,
      code: "workspace_busy",
    });
    releaseExclusive();
    await exclusive;
  });

  it("allows nested mutations under exclusive capability without self-deadlock", async () => {
    await withWorkspaceExclusive("destructive-reconcile", async () => {
      const nested = await withSharedMutationLease(async () => "ok");
      expect(nested).toBe("ok");
      expect(getWorkspaceExclusiveCapability()?.operation).toBe("destructive-reconcile");
    });
  });

  it("shares exclusive ALS authority across independently loaded gate modules", async () => {
    vi.resetModules();
    const secondGate = await import("@/lib/server/workspace-operation-gate");

    await withWorkspaceExclusive("restore", async () => {
      expect(secondGate.hasWorkspaceMutationAuthority()).toBe(true);
      await expect(
        secondGate.withSharedMutationLease(async () => "cross-bundle-ok"),
      ).resolves.toBe("cross-bundle-ok");
    });
  });

  it("counts detached video work as a shared lease holder", async () => {
    const admission = beginDetachedVideoWork();
    expect(getWorkspaceOperationGateStateForTests()).toMatchObject({
      sharedCount: 1,
      activeVideoCount: 1,
    });
    admission.release();
    expect(getWorkspaceOperationGateStateForTests()).toMatchObject({
      sharedCount: 0,
      activeVideoCount: 0,
    });
  });

  it("lets an admitted video settle nested mutations while exclusive is pending", async () => {
    const admission = beginDetachedVideoWork();
    let continueVideo!: () => void;
    let videoReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      videoReady = resolve;
    });
    const video = runWithDetachedVideoAdmission(admission, async () => {
      videoReady();
      await new Promise<void>((resolve) => {
        continueVideo = resolve;
      });
      return withSharedMutationLease(async () => "settled");
    });
    await ready;

    let exclusiveEntered = false;
    const exclusive = withWorkspaceExclusive("backup", async () => {
      exclusiveEntered = true;
    });
    await Promise.resolve();
    expect(getWorkspaceOperationGateStateForTests().exclusivePending).toBe(true);
    expect(exclusiveEntered).toBe(false);

    continueVideo();
    await expect(video).resolves.toBe("settled");
    expect(exclusiveEntered).toBe(false);
    admission.release();
    await exclusive;
    expect(exclusiveEntered).toBe(true);
  });
});
