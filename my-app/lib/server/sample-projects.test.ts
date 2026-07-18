import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  projectFindMany: vi.fn(),
  projectCreate: vi.fn(),
  generationJobCreate: vi.fn(),
  assetCreate: vi.fn(),
  canvasSessionCreate: vi.fn(),
  canvasLayerCreateMany: vi.fn(),
  transaction: vi.fn(),
  writeGeneratedImage: vi.fn(),
  deleteStoredFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  promises: { readFile: vi.fn().mockResolvedValue(Buffer.from("sample")) },
}));
vi.mock("@/lib/sample-data", () => ({
  SAMPLE_PROJECTS: [{
    id: "built-in-one",
    layers: [{ source: "samples/coffee-scene.webp", x: 0, y: 0, width: 100, height: 100 }],
  }],
  SAMPLE_SOURCE_MIME_TYPE: "image/webp",
}));
vi.mock("@/lib/i18n/server", () => ({ resolveLocale: vi.fn().mockResolvedValue("en") }));
vi.mock("@/lib/i18n/plain", () => ({
  getPlainT: () => (key: string) => key,
}));
vi.mock("@/lib/server/storage", () => ({
  writeGeneratedImage: mocks.writeGeneratedImage,
  deleteStoredFile: mocks.deleteStoredFile,
  restoreStoredFile: vi.fn(),
}));
vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    project: { findMany: mocks.projectFindMany },
    $transaction: mocks.transaction,
  },
}));

import { ensureBuiltInProjectTemplates } from "@/lib/server/sample-projects";

beforeEach(() => {
  vi.clearAllMocks();
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
  mocks.writeGeneratedImage.mockResolvedValue({
    storagePath: "generated/sample.webp",
    mimeType: "image/webp",
    byteSize: 6,
    width: 100,
    height: 100,
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

    expect(mocks.projectCreate).toHaveBeenCalledTimes(1);
    expect(mocks.projectCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ isTemplate: true, templateKey: "built-in-one" }),
      select: { id: true },
    });
    expect(mocks.projectCreate.mock.calls.every(([call]) => call.data.isTemplate === true)).toBe(true);
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
});
