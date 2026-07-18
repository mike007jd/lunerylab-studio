import "server-only";
import { Prisma, type GenerationJob, type Asset } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { ApiError } from "@/lib/server/errors";
import { createGenerationJob, type CreateGenerationJobInput } from "@/lib/server/generation-job";

export type IdempotentLookup =
  | { kind: "fresh" }
  | { kind: "cached"; job: GenerationJob; assets: Asset[] };

export type IdempotentCreate =
  | { kind: "created"; job: GenerationJob }
  | { kind: "cached"; job: GenerationJob; assets: Asset[] };

function conflictError(reason: "owner" | "fields"): ApiError {
  return new ApiError({
    status: 409,
    code: "idempotency_key_conflict",
    message:
      reason === "owner"
        ? "Idempotency key is already in use."
        : "Idempotency key is already in use for a different request.",
    retryable: false,
  });
}

/**
 * Look up an existing generation job by idempotency key, validate the request
 * is from the same user and matches the original parameters, then return any
 * cached generated assets.
 *
 * `match` returns `true` when the existing job's parameters are compatible
 * with the current request — caller-defined because each route has different
 * comparison rules (image vs edit vs video).
 */
export async function lookupIdempotentJob({
  key,
  userId,
  match,
}: {
  key: string | null;
  userId: string;
  match: (existing: GenerationJob) => boolean;
}): Promise<IdempotentLookup> {
  if (!key) return { kind: "fresh" };

  const existing = await prisma.generationJob.findUnique({
    where: { idempotencyKey: key },
  });
  if (!existing) return { kind: "fresh" };

  if (existing.userId !== userId) throw conflictError("owner");
  if (!match(existing)) throw conflictError("fields");

  const assets = await prisma.asset.findMany({
    where: { jobId: existing.id, kind: "GENERATED" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return { kind: "cached", job: existing, assets };
}

function isIdempotencyKeyConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

/**
 * Create a generation job, treating a same-key insert race as a replay rather
 * than an error.
 *
 * `lookupIdempotentJob` closes the common case where the first request has
 * already finished, but two requests carrying the same key can both observe
 * "fresh" and race to insert. The unique constraint on `idempotencyKey` lets
 * exactly one win; the loser hits Prisma `P2002`. Instead of surfacing that as
 * a generic 500, we reload the winning job and replay it through the same
 * owner/fingerprint checks — matching the idempotency contract callers expect
 * (a concurrent retry replays the first result, it does not randomly fail).
 */
export async function createIdempotentGenerationJob({
  input,
  userId,
  match,
}: {
  input: CreateGenerationJobInput;
  userId: string;
  match: (existing: GenerationJob) => boolean;
}): Promise<IdempotentCreate> {
  try {
    const job = await createGenerationJob(input);
    return { kind: "created", job };
  } catch (error) {
    if (input.idempotencyKey && isIdempotencyKeyConflict(error)) {
      const replay = await lookupIdempotentJob({ key: input.idempotencyKey, userId, match });
      if (replay.kind === "cached") return replay;
    }
    throw error;
  }
}

export async function createOrReplayGenerationJob({
  input,
  userId,
  requestFingerprint,
}: {
  input: CreateGenerationJobInput;
  userId: string;
  requestFingerprint: string;
}): Promise<IdempotentCreate> {
  const match = (existing: GenerationJob) => existing.requestFingerprint === requestFingerprint;
  const replay = await lookupIdempotentJob({
    key: input.idempotencyKey ?? null,
    userId,
    match,
  });
  if (replay.kind === "cached") return replay;
  return createIdempotentGenerationJob({ input, userId, match });
}
