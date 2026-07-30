import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/client/fetch-json";
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

function videoEntry(overrides: Partial<GenerationEntry> = {}): GenerationEntry {
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
    jobId: null,
    assets: [],
    warnings: [],
    error: "retry",
    createdAt: 1,
    ...overrides,
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

function fakeHistory(seed: GenerationEntry[] = [videoEntry()]) {
  let entries = seed;
  return {
    add(input: NewEntryInput) {
      const id = "new-video";
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

  it("serializes polls and ignores a poll after registry ownership is replaced", async () => {
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

    expect(registry.finish("video-A", "video-run-1")).toBe(true);
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

  it("releases after three transient 500s, then retry rejoins the same job", async () => {
    const history = fakeHistory([videoEntry({ status: "running", error: null })]);
    const registry = new GenerationActivityRegistry();
    let createCount = 0;
    let statusCount = 0;
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/generate/video" && init?.method === "POST") {
        createCount += 1;
        return {
          jobId: "job-rejoin",
          status: "RUNNING",
          duration: 6,
          projectId: null,
        };
      }
      statusCount += 1;
      if (statusCount <= 3) {
        throw new HttpError("upstream", { status: 500, statusText: "Internal Server Error" });
      }
      return { status: "SUCCEEDED", asset: videoAsset("recovered") };
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
      maxPollErrors: 3,
    });

    await controller.retry("video-A");
    await vi.waitFor(() => {
      expect(history.find("video-A")?.status).toBe("interrupted");
    });
    expect(registry.anyActive()).toBe(false);
    expect(history.find("video-A")?.jobId).toBe("job-rejoin");

    await controller.retry("video-A");
    await vi.waitFor(() => {
      expect(history.find("video-A")?.status).toBe("succeeded");
    });
    expect(createCount).toBe(1);
    expect(history.find("video-A")?.jobId).toBe("job-rejoin");
    expect(history.find("video-A")?.assets[0]?.id).toBe("recovered");
    expect(statusCount).toBe(4);
    expect(registry.anyActive()).toBe(false);
  });

  it("retains the same job across rate-limit responses and rejoins without duplicate creation", async () => {
    const history = fakeHistory([videoEntry({ status: "running", error: null })]);
    const registry = new GenerationActivityRegistry();
    let createCount = 0;
    let statusCount = 0;
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/generate/video" && init?.method === "POST") {
        createCount += 1;
        return {
          jobId: "job-rate-limited",
          status: "RUNNING",
          duration: 6,
          projectId: null,
        };
      }
      statusCount += 1;
      if (statusCount <= 3) {
        throw new HttpError("rate limited", {
          status: 429,
          statusText: "Too Many Requests",
        });
      }
      return { status: "SUCCEEDED", asset: videoAsset("rate-recovered") };
    });
    const controller = createVideoGenerationController({
      registry,
      history,
      t: (key) => key,
      request,
      wait: vi.fn(async () => undefined),
      maxPollErrors: 3,
    });

    await controller.retry("video-A");
    await vi.waitFor(() => {
      expect(history.find("video-A")?.status).toBe("interrupted");
    });
    expect(registry.anyActive()).toBe(false);
    expect(history.find("video-A")?.jobId).toBe("job-rate-limited");

    await controller.retry("video-A");
    await vi.waitFor(() => {
      expect(history.find("video-A")?.status).toBe("succeeded");
    });
    expect(createCount).toBe(1);
    expect(history.find("video-A")?.jobId).toBe("job-rate-limited");
    expect(statusCount).toBe(4);
  });
});
