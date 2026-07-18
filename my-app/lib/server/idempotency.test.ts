import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  jobFindUnique: vi.fn(),
  jobCreate: vi.fn(),
  assetFindMany: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    generationJob: { findUnique: mocks.jobFindUnique, create: mocks.jobCreate },
    asset: { findMany: mocks.assetFindMany },
  },
}));

import {
  createOrReplayGenerationJob,
  lookupIdempotentJob,
} from "@/lib/server/idempotency";
import type { CreateGenerationJobInput } from "@/lib/server/generation-job";

const baseInput: CreateGenerationJobInput = {
  userId: "user-1",
  source: "STUDIO",
  prompt: "cat",
  referenceCount: 0,
  requestedCount: 1,
  idempotencyKey: "key-1",
  requestFingerprint: "fp-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assetFindMany.mockResolvedValue([{ id: "a1" }]);
});

describe("lookupIdempotentJob", () => {
  it("is fresh when there is no key or no existing job", async () => {
    await expect(lookupIdempotentJob({ key: null, userId: "user-1", match: () => true })).resolves.toEqual({
      kind: "fresh",
    });
    mocks.jobFindUnique.mockResolvedValue(null);
    await expect(lookupIdempotentJob({ key: "key-1", userId: "user-1", match: () => true })).resolves.toEqual({
      kind: "fresh",
    });
  });

  it("replays the cached job + assets on a matching key", async () => {
    mocks.jobFindUnique.mockResolvedValue({ id: "j1", userId: "user-1", requestFingerprint: "fp-1" });
    const result = await lookupIdempotentJob({
      key: "key-1",
      userId: "user-1",
      match: (e) => e.requestFingerprint === "fp-1",
    });
    expect(result).toMatchObject({ kind: "cached", job: { id: "j1" }, assets: [{ id: "a1" }] });
  });

  it("rejects a key owned by a different user", async () => {
    mocks.jobFindUnique.mockResolvedValue({ id: "j1", userId: "someone-else" });
    await expect(
      lookupIdempotentJob({ key: "key-1", userId: "user-1", match: () => true }),
    ).rejects.toMatchObject({ code: "idempotency_key_conflict" });
  });

  it("rejects a key reused for different request parameters", async () => {
    mocks.jobFindUnique.mockResolvedValue({ id: "j1", userId: "user-1", requestFingerprint: "other" });
    await expect(
      lookupIdempotentJob({ key: "key-1", userId: "user-1", match: (e) => e.requestFingerprint === "fp-1" }),
    ).rejects.toMatchObject({ code: "idempotency_key_conflict" });
  });
});

describe("createOrReplayGenerationJob", () => {
  it("creates a fresh job when the key is unseen", async () => {
    mocks.jobFindUnique.mockResolvedValue(null);
    mocks.jobCreate.mockResolvedValue({ id: "j-new" });

    const result = await createOrReplayGenerationJob({
      input: baseInput,
      userId: "user-1",
      requestFingerprint: "fp-1",
    });
    expect(result).toEqual({ kind: "created", job: { id: "j-new" } });
  });

  it("replays the winner when two identical requests race to insert (P2002)", async () => {
    // Both requests saw "fresh"; this one loses the unique-constraint race.
    mocks.jobFindUnique
      .mockResolvedValueOnce(null) // initial lookup: fresh
      .mockResolvedValueOnce({ id: "j-winner", userId: "user-1", requestFingerprint: "fp-1" }); // replay after P2002
    mocks.jobCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "6" }),
    );

    const result = await createOrReplayGenerationJob({
      input: baseInput,
      userId: "user-1",
      requestFingerprint: "fp-1",
    });
    expect(result).toMatchObject({ kind: "cached", job: { id: "j-winner" }, assets: [{ id: "a1" }] });
  });

  it("rethrows a non-idempotency creation error", async () => {
    mocks.jobFindUnique.mockResolvedValue(null);
    mocks.jobCreate.mockRejectedValue(new Error("db down"));

    await expect(
      createOrReplayGenerationJob({ input: baseInput, userId: "user-1", requestFingerprint: "fp-1" }),
    ).rejects.toThrow("db down");
  });
});
