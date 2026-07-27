import { describe, expect, it, vi } from "vitest";
import { GenerationActivityRegistry } from "@/components/studio/controllers/generation-activity-registry";
import { createImageGenerationController } from "@/components/studio/controllers/image-generation-controller";
import type {
  GenerationEntry,
  NewEntryInput,
} from "@/components/studio/use-studio-generation-history";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

  it("prevents a stale completion from overwriting cancel and retry", async () => {
    const history = fakeHistory([entry("A")]);
    const registry = new GenerationActivityRegistry();
    const oldRequest = deferred<unknown>();
    const newRequest = deferred<unknown>();
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
      cancelNative: vi.fn(async () => undefined),
      createRunId: (() => {
        let id = 0;
        return () => `run-${++id}`;
      })(),
    });

    const oldRetry = controller.retry("A");
    await controller.cancel("A");
    const newRetry = controller.retry("A");
    expect(registry.get("A")?.runId).toBe("run-2");

    oldRequest.resolve(response("old"));
    await expect(oldRetry).resolves.toMatchObject({ stale: true });
    expect(history.find("A")?.assets).toEqual([]);

    newRequest.resolve(response("new"));
    await expect(newRetry).resolves.toMatchObject({ stale: false });
    expect(history.find("A")?.assets[0]?.id).toBe("new");
    expect(history.find("A")?.status).toBe("succeeded");
  });
});
