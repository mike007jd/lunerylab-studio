import type { GenerationJob, Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { ApiError, sanitizeProviderError } from "@/lib/server/errors";

/** Either the global client or an interactive-transaction client. */
type GenerationJobClient = typeof prisma | Prisma.TransactionClient;

export type GenerationJobSource = "STUDIO" | "TOOL";

export interface CreateGenerationJobInput {
  userId: string;
  projectId?: string | null;
  source: GenerationJobSource;
  prompt: string;
  referenceCount: number;
  requestedCount: number;
  provider?: string;
  model?: string;
  toolType?: string | null;
  idempotencyKey?: string | null;
  requestFingerprint?: string | null;
  type?: "image" | "video" | "model-3d";
  videoDuration?: number | null;
}

export function finalGenerationStatus(successCount: number, requestedCount: number) {
  if (successCount === 0) return "FAILED";
  if (successCount < requestedCount) return "PARTIAL";
  return "SUCCEEDED";
}

export async function createGenerationJob(input: CreateGenerationJobInput): Promise<GenerationJob> {
  return prisma.generationJob.create({
    data: {
      userId: input.userId,
      projectId: input.projectId || undefined,
      source: input.source,
      toolType: input.toolType,
      prompt: input.prompt,
      referenceCount: input.referenceCount,
      requestedCount: input.requestedCount,
      successCount: 0,
      status: "RUNNING",
      provider: input.provider ?? "pending",
      model: input.model ?? "pending",
      idempotencyKey: input.idempotencyKey || undefined,
      requestFingerprint: input.requestFingerprint || undefined,
      type: input.type,
      videoDuration: input.videoDuration ?? undefined,
    },
  });
}

export async function completeGenerationJob({
  jobId,
  model,
  provider,
  endpoint,
  successCount,
  requestedCount,
  emptyResultMessage,
  client = prisma,
}: {
  jobId: string;
  model: string;
  provider: string;
  /** Concrete runtime endpoint actually used (provenance); undefined for embedded/BYOK. */
  endpoint?: string;
  successCount: number;
  requestedCount: number;
  emptyResultMessage?: string;
  /**
   * Optional transaction client. Pass the same `tx` used to create the assets /
   * layers so the job's terminal state commits atomically with them — this
   * closes the "successful asset + failed job" window (an asset that exists but
   * whose job shows FAILED, or vice versa).
   */
  client?: GenerationJobClient;
}): Promise<GenerationJob> {
  const status = finalGenerationStatus(successCount, requestedCount);
  const updated = await client.generationJob.updateMany({
    where: { id: jobId, status: "RUNNING" },
    data: {
      model,
      provider,
      endpoint: endpoint ?? null,
      successCount,
      status,
      completedAt: new Date(),
      errorCode: successCount > 0 ? null : "generation_failed",
      errorMessage:
        successCount > 0
          ? null
          : (emptyResultMessage ?? `${provider} returned no generated output.`).slice(0, 300),
    },
  });
  if (updated.count !== 1) {
    throw new ApiError({
      status: 409,
      code: "generation_job_not_running",
      message: "Generation job is no longer running; late completion was ignored.",
      retryable: false,
    });
  }
  const job = await client.generationJob.findUnique({ where: { id: jobId } });
  if (!job) {
    throw new ApiError({
      status: 404,
      code: "generation_job_not_found",
      message: "Generation job was not found.",
      retryable: false,
    });
  }
  return job;
}

export async function failRunningGenerationJob({
  jobId,
  error,
  fallbackCode,
}: {
  jobId: string;
  error: unknown;
  fallbackCode: string;
}) {
  const sanitized =
    error instanceof ApiError
      ? { code: error.code, message: error.message }
      : sanitizeProviderError(error, fallbackCode);

  await prisma.generationJob.updateMany({
    where: { id: jobId, status: "RUNNING" },
    data: {
      status: "FAILED",
      errorCode: sanitized.code,
      errorMessage: sanitized.message,
      completedAt: new Date(),
    },
  }).catch(() => undefined);
}
