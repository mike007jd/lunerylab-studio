import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  assertOwnedProject: vi.fn(),
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  count: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  assetFindMany: vi.fn(),
}));

vi.mock("@/lib/server/project-ownership", () => ({
  assertOwnedProject: mocks.assertOwnedProject,
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    $transaction: mocks.$transaction,
    referenceSet: {
      count: mocks.count,
      updateMany: mocks.updateMany,
      create: mocks.create,
      update: mocks.update,
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
    },
    referenceSetAsset: {
      deleteMany: mocks.deleteMany,
      createMany: mocks.createMany,
    },
    asset: {
      findMany: mocks.assetFindMany,
    },
  },
}));

import {
  createReferenceSet,
  parseReferenceSetAssetIds,
  updateReferenceSet,
} from "@/lib/server/reference-set";
import { ApiError } from "@/lib/server/errors";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertOwnedProject.mockResolvedValue(undefined);
  mocks.assetFindMany.mockResolvedValue([]);
  mocks.$queryRaw.mockResolvedValue([{ id: "project-1" }]);
  mocks.count.mockResolvedValue(0);
  mocks.updateMany.mockResolvedValue({ count: 0 });
  mocks.create.mockResolvedValue({
    id: "set-1",
    projectId: "project-1",
    name: "Mood",
    description: null,
    assets: [],
    isDefault: true,
    updatedAt: new Date("2026-07-30T00:00:00.000Z"),
  });
  mocks.findFirst.mockResolvedValue({ id: "set-1" });
  mocks.update.mockResolvedValue({
    id: "set-1",
    projectId: "project-1",
    name: "Mood",
    description: null,
    assets: [],
    isDefault: true,
    updatedAt: new Date("2026-07-30T00:00:00.000Z"),
  });
  mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: mocks.$queryRaw,
      referenceSet: {
        count: mocks.count,
        updateMany: mocks.updateMany,
        create: mocks.create,
        update: mocks.update,
      },
      referenceSetAsset: {
        deleteMany: mocks.deleteMany,
        createMany: mocks.createMany,
      },
    }),
  );
});

describe("parseReferenceSetAssetIds", () => {
  it("trims values, drops empty strings, and keeps first unique ids", () => {
    expect(parseReferenceSetAssetIds([" asset-a ", "", "asset-b", "asset-a", "  ", "asset-c"])).toEqual([
      "asset-a",
      "asset-b",
      "asset-c",
    ]);
  });

  it("ignores non-string array items", () => {
    expect(parseReferenceSetAssetIds(["asset-a", 12, null, "asset-b", { id: "asset-c" }])).toEqual([
      "asset-a",
      "asset-b",
    ]);
  });

  it("returns null for non-array input", () => {
    expect(parseReferenceSetAssetIds("asset-a")).toBeNull();
    expect(parseReferenceSetAssetIds(undefined)).toBeNull();
  });
});

describe("reference set concurrency guards", () => {
  it("locks the owned project row before counting on create", async () => {
    await createReferenceSet("project-1", "user-1", { name: "Mood", isDefault: true });
    expect(mocks.$queryRaw).toHaveBeenCalled();
    expect(mocks.count).toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalled();
  });

  it("rejects create when the per-project limit is reached under the project lock", async () => {
    mocks.count.mockResolvedValue(24);
    await expect(
      createReferenceSet("project-1", "user-1", { name: "Overflow" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "reference_set_limit_reached",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("maps default unique-constraint races to a stable 409", async () => {
    mocks.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup default", {
        code: "P2002",
        clientVersion: "6",
      }),
    );
    await expect(
      createReferenceSet("project-1", "user-1", { name: "Default race", isDefault: true }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      createReferenceSet("project-1", "user-1", { name: "Default race", isDefault: true }),
    ).rejects.toMatchObject({
      status: 409,
      code: "reference_set_default_conflict",
    });
  });

  it("locks the project before default-update mutations", async () => {
    await updateReferenceSet("project-1", "user-1", "set-1", { isDefault: true });
    expect(mocks.$queryRaw).toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalled();
  });
});
