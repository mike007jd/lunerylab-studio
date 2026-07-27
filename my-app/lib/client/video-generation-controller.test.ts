import { describe, expect, it, vi } from "vitest";
import { GenerationActivityRegistry } from "@/components/studio/controllers/generation-activity-registry";
import { createVideoGenerationController } from "@/components/studio/hooks/use-video-generation";
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

function videoEntry(): GenerationEntry {
  return {
    id: "video-A",
    mode: "video",
    status: "failed",
    prompt: "motion",
    modelId: "byok:test/video",
    aspectRatio: "16:9",
    count: 1,
    presetId: null,
    projectId: null,
    referenceAssetIds: [],
    batchVariants: null,
    generationParameters: {},
    videoDuration: 6,
    assets: [],
    warnings: [],
    error: "retry",
    createdAt: 1,
  };
}

function videoAsset(id: string) {
  return {
    id,
    jobId: `job-${id}`,
    projectId: null,
    kind: "GENERATED" as const,
    origin: "USER" as const,
    modality: "VIDEO" as const,
    mimeType: "video/mp4",
    byteSize: 1,
    width: 1920,
    height: 1080,
    format: "mp4",
    durationSeconds: 6,
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

function fakeHistory() {
  let entries = [videoEntry()];
  return {
    add(input: NewEntryInput) {
      const id = "new-video";
      entries = [{
        ...input,
        id,
        status: input.status ?? "running",
        assets: [],
        warnings: [],
        error: null,
        createdAt: 1,
      }, ...entries];
      return id;
    },
    update(id: string, patch: Partial<GenerationEntry>) {
      entries = entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
    },
    find(id: string) {
      return entries.find((entry) => entry.id === id) ?? null;
    },
  };
}

describe("entry-aware video generation controller", () => {
  it("does not clear terminal state when a duplicate retry is already active", async () => {
    const history = fakeHistory();
    const registry = new GenerationActivityRegistry();
    registry.begin({
      entryId: "video-A",
      runId: "existing",
      mode: "video",
      requestController: new AbortController(),
      pollController: new AbortController(),
    });
    const controller = createVideoGenerationController({
      registry,
      history,
      t: (key) => key,
      request: vi.fn(),
    });

    await expect(controller.retry("video-A")).resolves.toEqual({ started: false });
    expect(history.find("video-A")?.status).toBe("failed");
    expect(history.find("video-A")?.error).toBe("retry");
    registry.abortAll();
  });

  it("serializes polls and ignores a stale poll after cancel/retry", async () => {
    const history = fakeHistory();
    const registry = new GenerationActivityRegistry();
    const oldStatus = deferred<unknown>();
    const newStatus = deferred<unknown>();
    let createCount = 0;
    let statusCount = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/generate/video") {
        createCount += 1;
        return {
          jobId: `job-${createCount}`,
          status: "RUNNING",
          duration: 6,
          projectId: null,
        };
      }
      statusCount += 1;
      return statusCount === 1 ? oldStatus.promise : newStatus.promise;
    });
    const controller = createVideoGenerationController({
      registry,
      history,
      t: (key) => key,
      request,
      wait: vi.fn(async () => undefined),
      createRunId: (() => {
        let id = 0;
        return () => `video-run-${++id}`;
      })(),
    });

    await controller.retry("video-A");
    expect(statusCount).toBe(1);
    await Promise.resolve();
    expect(statusCount).toBe(1);

    expect(controller.cancel("video-A")).toBe(true);
    await controller.retry("video-A");
    expect(registry.get("video-A")?.runId).toBe("video-run-2");

    oldStatus.resolve({ status: "SUCCEEDED", asset: videoAsset("old") });
    await Promise.resolve();
    expect(history.find("video-A")?.assets).toEqual([]);

    newStatus.resolve({ status: "SUCCEEDED", asset: videoAsset("new") });
    await vi.waitFor(() => {
      expect(history.find("video-A")?.assets[0]?.id).toBe("new");
    });
    expect(registry.anyActive()).toBe(false);
  });
});
