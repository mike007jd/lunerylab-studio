import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  projectFindMany: vi.fn(),
  projectCreate: vi.fn(),
  generationJobCreate: vi.fn(),
  assetCreate: vi.fn(),
  canvasSessionCreate: vi.fn(),
  canvasLayerCreateMany: vi.fn(),
  userSettingsFindUnique: vi.fn(),
  transaction: vi.fn(),
  writeGeneratedImage: vi.fn(),
  writeFilesOrCleanup: vi.fn(),
  deleteStoredFile: vi.fn(),
  getPlainT: vi.fn(),
  sampleProjects: [{
    id: "built-in-one",
    layers: [
      { source: "samples/coffee-scene.webp", x: 0, y: 0, width: 100, height: 100 },
      { source: "samples/ceramic-vase.webp", x: 100, y: 0, width: 100, height: 100 },
    ],
  }],
}));

vi.mock("node:fs", () => ({
  promises: { readFile: vi.fn().mockResolvedValue(Buffer.from("sample")) },
}));
vi.mock("@/lib/sample-data", () => ({
  SAMPLE_PROJECTS: mocks.sampleProjects,
  SAMPLE_SOURCE_MIME_TYPE: "image/webp",
}));
vi.mock("@/lib/i18n/plain", () => ({
  getPlainT: mocks.getPlainT,
}));
vi.mock("@/lib/server/storage", () => ({
  writeGeneratedImage: mocks.writeGeneratedImage,
  deleteStoredFile: mocks.deleteStoredFile,
  writeFilesOrCleanup: mocks.writeFilesOrCleanup,
  restoreStoredFile: vi.fn(),
}));
vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    project: { findMany: mocks.projectFindMany },
    userSettings: { findUnique: mocks.userSettingsFindUnique },
    $transaction: mocks.transaction,
  },
}));

import { ensureBuiltInProjectTemplates } from "@/lib/server/sample-projects";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sampleProjects.splice(1);
  const templateKeys = new Set<string>();
  mocks.projectFindMany.mockImplementation(async () =>
    [...templateKeys].map((templateKey) => ({ templateKey })),
  );
  mocks.projectCreate.mockImplementation(async ({ data }: { data: { templateKey: string } }) => {
    templateKeys.add(data.templateKey);
    return { id: `template-${data.templateKey}` };
  });
  mocks.generationJobCreate.mockResolvedValue({ id: "job-1" });
  mocks.assetCreate.mockResolvedValue({ id: "asset-1" });
  mocks.canvasSessionCreate.mockResolvedValue({ id: "session-1" });
  mocks.userSettingsFindUnique.mockResolvedValue({ defaultLocale: "en" });
  mocks.getPlainT.mockImplementation(() => (key: string) => key);
  mocks.writeGeneratedImage.mockResolvedValue({
    storagePath: "generated/sample.webp",
    mimeType: "image/webp",
    byteSize: 6,
    width: 100,
    height: 100,
  });
  mocks.writeFilesOrCleanup.mockImplementation(async (writers: Array<() => Promise<{
    storagePath: string;
  }>>) => {
    const settled = await Promise.allSettled(writers.map((writer) => writer()));
    const written = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []);
    const failure = settled.find((result): result is PromiseRejectedResult =>
      result.status === "rejected");
    if (failure) {
      await Promise.allSettled(written.map((file) => mocks.deleteStoredFile(file.storagePath)));
      throw failure.reason;
    }
    return written;
  });
  mocks.transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation({
    project: { create: mocks.projectCreate },
    generationJob: { create: mocks.generationJobCreate },
    asset: { create: mocks.assetCreate },
    canvasSession: { create: mocks.canvasSessionCreate },
    canvasLayer: { createMany: mocks.canvasLayerCreateMany },
  }));
});

describe("built-in project template initialization", () => {
  it("fills missing templates without creating a personal project", async () => {
    await ensureBuiltInProjectTemplates("owner-1");

    expect(mocks.userSettingsFindUnique).toHaveBeenCalledWith({
      where: { userId: "owner-1" },
      select: { defaultLocale: true },
    });
    expect(mocks.getPlainT).toHaveBeenCalledWith("en");
    expect(mocks.projectCreate).toHaveBeenCalledTimes(1);
    expect(mocks.projectCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ isTemplate: true, templateKey: "built-in-one" }),
      select: { id: true },
    });
    expect(mocks.projectCreate.mock.calls.every(([call]) => call.data.isTemplate === true)).toBe(true);
  });

  it("uses the profile locale without re-entering workspace initialization", async () => {
    mocks.userSettingsFindUnique.mockResolvedValue({ defaultLocale: "zh-Hant" });

    await ensureBuiltInProjectTemplates("owner-1");

    expect(mocks.getPlainT).toHaveBeenCalledWith("zh-TW");
  });

  it("is idempotent across repeated initialization", async () => {
    await ensureBuiltInProjectTemplates("owner-1");
    await ensureBuiltInProjectTemplates("owner-1");

    expect(mocks.projectCreate).toHaveBeenCalledTimes(1);
  });

  it("does not block startup when a template fails", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("template write failed"));

    await expect(ensureBuiltInProjectTemplates("owner-1")).resolves.toBeUndefined();
    expect(mocks.deleteStoredFile).toHaveBeenCalledWith("generated/sample.webp");
  });

  it("serializes template transactions for the single-connection PGlite runtime", async () => {
    mocks.sampleProjects.push({
      id: "built-in-two",
      layers: [
        { source: "samples/coffee-scene.webp", x: 0, y: 0, width: 100, height: 100 },
      ],
    });
    let activeTransactions = 0;
    let maximumActiveTransactions = 0;
    mocks.transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => {
      activeTransactions += 1;
      maximumActiveTransactions = Math.max(maximumActiveTransactions, activeTransactions);
      try {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        return await operation({
          project: { create: mocks.projectCreate },
          generationJob: { create: mocks.generationJobCreate },
          asset: { create: mocks.assetCreate },
          canvasSession: { create: mocks.canvasSessionCreate },
          canvasLayer: { createMany: mocks.canvasLayerCreateMany },
        });
      } finally {
        activeTransactions -= 1;
      }
    });

    await ensureBuiltInProjectTemplates("owner-1");

    expect(mocks.projectCreate).toHaveBeenCalledTimes(2);
    expect(maximumActiveTransactions).toBe(1);
  });

  it("serializes asset inserts inside each transaction", async () => {
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    mocks.assetCreate.mockImplementation(async () => {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      activeWrites -= 1;
      return { id: `asset-${mocks.assetCreate.mock.calls.length}` };
    });

    await ensureBuiltInProjectTemplates("owner-1");

    expect(mocks.assetCreate).toHaveBeenCalledTimes(2);
    expect(maximumActiveWrites).toBe(1);
  });

  it("cleans the first file when a later sample-layer write fails, then retries once", async () => {
    mocks.writeGeneratedImage
      .mockResolvedValueOnce({
        storagePath: "generated/first.webp",
        mimeType: "image/webp",
        byteSize: 5,
        width: 100,
        height: 100,
      })
      .mockRejectedValueOnce(new Error("second write failed"));

    await expect(ensureBuiltInProjectTemplates("owner-1")).resolves.toBeUndefined();
    expect(mocks.deleteStoredFile).toHaveBeenCalledWith("generated/first.webp");
    expect(mocks.transaction).not.toHaveBeenCalled();

    mocks.writeGeneratedImage.mockResolvedValue({
      storagePath: "generated/retry.webp",
      mimeType: "image/webp",
      byteSize: 5,
      width: 100,
      height: 100,
    });
    await ensureBuiltInProjectTemplates("owner-1");
    expect(mocks.projectCreate).toHaveBeenCalledTimes(1);
  });
});
