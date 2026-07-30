import { describe, expect, it, vi } from "vitest";
import { GenerationActivityRegistry } from "@/components/studio/controllers/generation-activity-registry";
import { createImageGenerationController } from "@/components/studio/controllers/image-generation-controller";
import type {
  GenerationEntry,
  NewEntryInput,
} from "@/components/studio/use-studio-generation-history";
import type { SdProgress } from "@/lib/types/sd-progress";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function entry(id: string): GenerationEntry {
  return {
    id,
    mode: "image",
    status: "failed",
    prompt: id,
    modelId: "local/test",
    aspectRatio: "1:1",
    count: 1,
    presetId: null,
    projectId: null,
    referenceAssetIds: [],
    batchVariants: null,
    generationParameters: {},
    videoDuration: null,
    jobId: null,
    assets: [],
    warnings: [],
    error: "retry",
    createdAt: 1,
  };
}

function asset(id: string) {
  return {
    id,
    jobId: `job-${id}`,
    projectId: null,
    kind: "GENERATED" as const,
    origin: "USER" as const,
    modality: "IMAGE" as const,
    mimeType: "image/png",
    byteSize: 1,
    width: 1,
    height: 1,
    format: "png",
    durationSeconds: null,
    tags: [],
    isFavorite: false,
    note: null,
    summary: null,
    agentTaskId: null,
    parentAssetId: null,
    deletedAt: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    url: `/api/assets/${id}/content`,
  };
}

function response(id: string) {
  return {
    job: {
      id: `job-${id}`,
      status: "SUCCEEDED" as const,
      requestedCount: 1,
      successCount: 1,
      errorCode: null,
      errorMessage: null,
      projectId: null,
    },
    assets: [asset(id)],
    warnings: [],
  };
}

function fakeHistory(initial: GenerationEntry[]) {
  let entries = initial;
  return {
    add(input: NewEntryInput) {
      const id = `new-${entries.length}`;
      entries = [
        {
          ...input,
          id,
          status: input.status ?? "running",
          jobId: input.jobId ?? null,
          assets: [],
          warnings: [],
          error: null,
          createdAt: 1,
        },
        ...entries,
      ];
      return id;
    },
    update(id: string, patch: Partial<GenerationEntry>) {
      entries = entries.map((item) => (item.id === id ? { ...item, ...patch } : item));
    },
    find(id: string) {
      return entries.find((item) => item.id === id) ?? null;
    },
    entries: () => entries,
  };
}

function createProgressStore() {
  let progressByEntry: Record<string, SdProgress | undefined> = {};
  return {
    get: () => progressByEntry,
    setProgress(
      updater: (
        current: Record<string, SdProgress | undefined>,
      ) => Record<string, SdProgress | undefined>,
    ) {
      progressByEntry = updater(progressByEntry);
    },
  };
}

describe("image generation controller concurrency", () => {
  it("does not mark a terminal entry running when the registry rejects a duplicate retry", async () => {
    const history = fakeHistory([entry("A")]);
    const registry = new GenerationActivityRegistry();
    registry.begin({
      entryId: "A",
      runId: "existing",
      mode: "image",
      requestController: new AbortController(),
      pollController: new AbortController(),
    });
    const controller = createImageGenerationController({
      registry,
      history,
      imageModels: [],
      t: (key) => key,
      setProgress: () => undefined,
      request: vi.fn(),
    });

    await expect(controller.retry("A")).resolves.toEqual({ started: false });
    expect(history.find("A")?.status).toBe("failed");
    expect(history.find("A")?.error).toBe("retry");
    registry.abortAll();
  });

  it("keeps concurrent B busy when A completes first", async () => {
    const history = fakeHistory([entry("A"), entry("B")]);
    const registry = new GenerationActivityRegistry();
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    const request = vi.fn()
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    const controller = createImageGenerationController({
      registry,
      history,
      imageModels: [],
      t: (key) => key,
      setProgress: () => undefined,
      request,
      pollProgress: vi.fn(async () => undefined),
      createRunId: (() => {
        let id = 0;
        return () => `run-${++id}`;
      })(),
    });

    const retryA = controller.retry("A");
    const retryB = controller.retry("B");
    expect([...registry.getSnapshot().keys()]).toEqual(["A", "B"]);

    a.resolve(response("asset-A"));
    await retryA;
    expect(registry.get("A")).toBeUndefined();
    expect(registry.get("B")?.runId).toBe("run-2");
    expect(history.find("A")?.status).toBe("succeeded");
    expect(history.find("B")?.status).toBe("running");

    b.resolve(response("asset-B"));
    await retryB;
    expect(registry.anyActive()).toBe(false);
  });
});

describe("acknowledged image cancellation ownership", () => {
  it("waits for native acknowledgement and keeps registry/progress active beforehand", async () => {
    const history = fakeHistory([entry("A")]);
    const registry = new GenerationActivityRegistry();
    const progress = createProgressStore();
    const request = deferred<unknown>();
    const nativeCancel = deferred<void>();
    const cancelNative = vi.fn(() => nativeCancel.promise);
    const controller = createImageGenerationController({
      registry,
      history,
      imageModels: [],
      t: (key) => key,
      setProgress: progress.setProgress,
      request: vi.fn().mockReturnValue(request.promise),
      pollProgress: vi.fn(async () => undefined),
      cancelNative,
      createRunId: () => "run-1",
    });

    const running = controller.retry("A");
    expect(registry.get("A")?.runId).toBe("run-1");
    expect(progress.get()["A"]?.runId).toBe("run-1");

    const cancelPromise = controller.cancel("A");
    expect(cancelNative).toHaveBeenCalledWith("run-1");
    expect(registry.get("A")?.cancelRequested).toBe(true);
    expect(registry.get("A")?.runId).toBe("run-1");
    expect(progress.get()["A"]?.runId).toBe("run-1");
    expect(history.find("A")?.status).toBe("running");
    expect(registry.get("A")?.requestController.signal.aborted).toBe(false);

    request.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await Promise.resolve();
    expect(registry.get("A")?.runId).toBe("run-1");
    expect(progress.get()["A"]?.runId).toBe("run-1");
    expect(history.find("A")?.status).toBe("running");

    nativeCancel.resolve();
    await expect(cancelPromise).resolves.toBe(true);
    await expect(running).resolves.toMatchObject({
      started: true,
      stale: false,
      error: null,
    });
    expect(history.find("A")?.status).toBe("canceled");
    expect(registry.get("A")).toBeUndefined();
    expect(progress.get()["A"]).toBeUndefined();
  });

  it("propagates acknowledgement failure without aborting, finishing, or terminal history", async () => {
    const history = fakeHistory([entry("A")]);
    const registry = new GenerationActivityRegistry();
    const progress = createProgressStore();
    const request = deferred<unknown>();
    const cancelNative = vi.fn(async () => {
      throw new Error("native cancel failed");
    });
    const controller = createImageGenerationController({
      registry,
      history,
      imageModels: [],
      t: (key) => key,
      setProgress: progress.setProgress,
      request: vi.fn().mockReturnValue(request.promise),
      pollProgress: vi.fn(async () => undefined),
      cancelNative,
      createRunId: () => "run-1",
    });

    const running = controller.retry("A");
    await expect(controller.cancel("A")).rejects.toThrow("native cancel failed");

    expect(registry.get("A")?.runId).toBe("run-1");
    expect(registry.get("A")?.cancelRequested).toBe(false);
    expect(registry.get("A")?.requestController.signal.aborted).toBe(false);
    expect(history.find("A")?.status).toBe("running");
    expect(progress.get()["A"]?.runId).toBe("run-1");

    request.resolve(response("still-running"));
    await expect(running).resolves.toMatchObject({ stale: false });
    expect(history.find("A")?.status).toBe("succeeded");
    expect(history.find("A")?.assets[0]?.id).toBe("still-running");
  });

  it("rejects retry during cancel teardown and allows retry after teardown", async () => {
    const history = fakeHistory([entry("A")]);
    const registry = new GenerationActivityRegistry();
    const progress = createProgressStore();
    const oldRequest = deferred<unknown>();
    const newRequest = deferred<unknown>();
    const nativeCancel = deferred<void>();
    const request = vi.fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    const controller = createImageGenerationController({
      registry,
      history,
      imageModels: [],
      t: (key) => key,
      setProgress: progress.setProgress,
      request,
      pollProgress: vi.fn(async () => undefined),
      cancelNative: vi.fn(() => nativeCancel.promise),
      createRunId: (() => {
        let id = 0;
        return () => `run-${++id}`;
      })(),
    });

    const oldRetry = controller.retry("A");
    const cancelPromise = controller.cancel("A");

    await expect(controller.retry("A")).resolves.toEqual({ started: false });
    expect(registry.get("A")?.runId).toBe("run-1");
    expect(history.find("A")?.status).toBe("running");

    nativeCancel.resolve();
    await expect(cancelPromise).resolves.toBe(true);
    await expect(controller.retry("A")).resolves.toEqual({ started: false });

    oldRequest.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(oldRetry).resolves.toMatchObject({ stale: false });
    expect(history.find("A")?.status).toBe("canceled");
    expect(registry.get("A")).toBeUndefined();
    expect(progress.get()["A"]).toBeUndefined();

    const newRetry = controller.retry("A");
    expect(registry.get("A")).toBeDefined();
    expect(registry.get("A")?.runId).not.toBe("run-1");
    newRequest.resolve(response("new"));
    await expect(newRetry).resolves.toMatchObject({ stale: false });
    expect(history.find("A")?.status).toBe("succeeded");
    expect(history.find("A")?.assets[0]?.id).toBe("new");
  });

  it("prevents a non-cooperative old completion from overwriting cancel or a later retry", async () => {
    const history = fakeHistory([entry("A")]);
    const registry = new GenerationActivityRegistry();
    const oldRequest = deferred<unknown>();
    const newRequest = deferred<unknown>();
    const nativeCancel = deferred<void>();
    const controller = createImageGenerationController({
      registry,
      history,
      imageModels: [],
      t: (key) => key,
      setProgress: () => undefined,
      request: vi.fn()
        .mockReturnValueOnce(oldRequest.promise)
        .mockReturnValueOnce(newRequest.promise),
      pollProgress: vi.fn(async () => undefined),
      cancelNative: vi.fn(() => nativeCancel.promise),
      createRunId: (() => {
        let id = 0;
        return () => `run-${++id}`;
      })(),
    });

    const oldRetry = controller.retry("A");
    const cancelPromise = controller.cancel("A");
    oldRequest.resolve(response("old"));
    await Promise.resolve();
    expect(registry.get("A")?.runId).toBe("run-1");
    expect(history.find("A")?.status).toBe("running");

    nativeCancel.resolve();
    await expect(cancelPromise).resolves.toBe(true);
    await expect(oldRetry).resolves.toMatchObject({
      started: true,
      outcome: null,
      stale: false,
    });
    expect(history.find("A")?.status).toBe("canceled");
    expect(history.find("A")?.assets).toEqual([]);
    expect(registry.get("A")).toBeUndefined();

    const newRetry = controller.retry("A");
    expect(registry.get("A")?.runId).toBe("run-2");
    newRequest.resolve(response("new"));
    await expect(newRetry).resolves.toMatchObject({ stale: false });
    expect(history.find("A")?.assets[0]?.id).toBe("new");
    expect(history.find("A")?.status).toBe("succeeded");
  });

});
