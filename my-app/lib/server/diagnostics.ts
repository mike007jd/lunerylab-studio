import "server-only";

import { prisma } from "@/lib/server/prisma";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import { fetchDesktopStatusSnapshot } from "@/lib/server/byok-shared";
import { getStorageBreakdown, type StorageBreakdown } from "@/lib/server/storage-breakdown";

/**
 * Redacted diagnostics bundle: enough to triage a failure (is the model missing,
 * the runtime unreachable, the provider failing, the disk full, the DB unhappy?)
 * without leaking anything sensitive.
 *
 * Deliberately EXCLUDED: API keys (never in the DB), prompts, reference images,
 * and generated media. User home paths are redacted to `~`. `excluded` records
 * this so the bundle is safe to attach to a public issue.
 */
export interface DiagnosticsBundle {
  generatedAt: string;
  app: {
    version: string;
    platform: string;
    arch: string;
    nodeVersion: string;
    isDesktop: boolean;
  };
  runtime: {
    localRuntimes: Array<{ id: string; status: string }>;
    configuredProviders: string[];
  } | null;
  storage: StorageBreakdown;
  recentJobs: Array<{
    id: string;
    type: string;
    status: string;
    provider: string;
    model: string;
    endpoint: string | null;
    errorCode: string | null;
    createdAt: string;
    completedAt: string | null;
  }>;
  recentAgentTasks: Array<{
    id: string;
    status: string;
    errorCode: string | null;
    createdAt: string;
  }>;
  excluded: string[];
}

const APP_VERSION = "1.0.0";
const RECENT_LIMIT = 20;

function redactHomePath(value: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home && value.includes(home) ? value.split(home).join("~") : value;
}

function agentErrorCode(error: unknown): string | null {
  // AgentTask.error is JSON; surface only a short `code`, never the full body
  // (which can echo prompt/user content).
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code.slice(0, 80);
  }
  return null;
}

export async function buildDiagnosticsBundle(userId: string): Promise<DiagnosticsBundle> {
  const [snapshot, storage, jobs, tasks] = await Promise.all([
    isDesktopRuntime() ? fetchDesktopStatusSnapshot().catch(() => null) : Promise.resolve(null),
    getStorageBreakdown(userId),
    prisma.generationJob.findMany({
      where: { userId, origin: "USER" },
      orderBy: { createdAt: "desc" },
      take: RECENT_LIMIT,
      select: {
        id: true,
        type: true,
        status: true,
        provider: true,
        model: true,
        endpoint: true,
        errorCode: true,
        createdAt: true,
        completedAt: true,
      },
    }),
    prisma.agentTask.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: RECENT_LIMIT,
      select: { id: true, status: true, error: true, createdAt: true },
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    app: {
      version: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      isDesktop: isDesktopRuntime(),
    },
    runtime: snapshot
      ? {
          localRuntimes: snapshot.local_runtimes.map((r) => ({ id: r.id, status: r.status })),
          configuredProviders: snapshot.providers.filter((p) => p.configured).map((p) => p.id),
        }
      : null,
    storage,
    recentJobs: jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      provider: job.provider,
      model: job.model,
      endpoint: job.endpoint ? redactHomePath(job.endpoint) : null,
      errorCode: job.errorCode,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    })),
    recentAgentTasks: tasks.map((task) => ({
      id: task.id,
      status: task.status,
      errorCode: agentErrorCode(task.error),
      createdAt: task.createdAt.toISOString(),
    })),
    excluded: ["api-keys", "prompts", "reference-images", "generated-media"],
  };
}
