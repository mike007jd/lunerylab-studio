import "server-only";

import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/server/errors";
import { prisma } from "@/lib/server/prisma";
import { requireWritableCanvasSession } from "@/lib/server/canvas-session-access";
import type { AgentRunResult, AgentStep } from "@/lib/server/agent/runtime/types";

export interface PersistedAgentMessage {
  id: string;
  role: "user" | "assistant";
  parts: Array<Record<string, unknown>>;
}

interface CreateAgentTaskInput {
  userId: string;
  sessionId: string;
  prompt: string;
  selectedLayerId: string | null;
  textModelId: string;
  uiContext: object;
  action?: Record<string, unknown>;
  userParts: Array<Record<string, unknown>>;
}

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function asNullableInputJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value == null ? Prisma.JsonNull : asInputJson(value);
}

export async function createAgentTask(input: CreateAgentTaskInput) {
  await requireWritableCanvasSession(input.sessionId, input.userId);

  return prisma.agentTask.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId,
      status: "RUNNING",
      prompt: input.prompt,
      selectedLayerId: input.selectedLayerId,
      textModelId: input.textModelId || null,
      uiContext: asInputJson(input.uiContext),
      action: input.action ? asInputJson(input.action) : undefined,
      messages: {
        create: {
          sessionId: input.sessionId,
          role: "USER",
          parts: asInputJson(input.userParts),
        },
      },
    },
    select: { id: true, createdAt: true },
  });
}

function toStepStatus(status: AgentStep["status"]): "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" {
  return status.toUpperCase() as "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
}

export async function persistAgentTaskStep(taskId: string, step: AgentStep): Promise<void> {
  await prisma.agentTaskStep.upsert({
    where: { taskId_index: { taskId, index: step.index } },
    update: {
      toolCallId: step.id,
      toolName: step.toolName,
      category: step.category,
      status: toStepStatus(step.status),
      summary: step.summary,
      input: asNullableInputJson(step.input),
      output: asNullableInputJson(step.output),
      artifacts: asInputJson(step.artifacts),
      startedAt: new Date(step.startedAt),
      completedAt: step.completedAt ? new Date(step.completedAt) : null,
      errorMessage: step.errorMessage ?? null,
    },
    create: {
      taskId,
      index: step.index,
      toolCallId: step.id,
      toolName: step.toolName,
      category: step.category,
      status: toStepStatus(step.status),
      summary: step.summary,
      input: step.input ? asInputJson(step.input) : undefined,
      output: step.output ? asInputJson(step.output) : undefined,
      artifacts: asInputJson(step.artifacts),
      startedAt: new Date(step.startedAt),
      completedAt: step.completedAt ? new Date(step.completedAt) : null,
      errorMessage: step.errorMessage ?? null,
    },
  });
}

export async function finishAgentTask({
  taskId,
  result,
  assistantParts,
  cancelled,
}: {
  taskId: string;
  result: AgentRunResult;
  assistantParts: Array<Record<string, unknown>>;
  cancelled?: boolean;
}): Promise<void> {
  const status = cancelled
    ? "CANCELLED"
    : result.capabilityFix && result.steps.length === 0
      ? "BLOCKED_CONFIGURATION"
      : result.error && result.steps.some((step) => step.status === "completed")
        ? "PARTIAL"
        : result.error
          ? "FAILED"
          : "COMPLETED";

  const task = await prisma.agentTask.findUniqueOrThrow({
    where: { id: taskId },
    select: { sessionId: true },
  });
  await prisma.$transaction([
    prisma.agentMessage.create({
      data: {
        sessionId: task.sessionId,
        taskId,
        role: "ASSISTANT",
        parts: asInputJson(assistantParts),
      },
    }),
    prisma.agentTask.update({
      where: { id: taskId },
      data: {
        status,
        capabilityFix: result.capabilityFix ? asInputJson(result.capabilityFix) : Prisma.JsonNull,
        error: result.error ? asInputJson(result.error) : Prisma.JsonNull,
        completedAt: new Date(),
      },
    }),
  ]);
}

export async function failAgentTask(
  taskId: string,
  error: { code?: string; message: string },
  options: { assistantParts?: Array<Record<string, unknown>>; cancelled?: boolean } = {},
): Promise<void> {
  const task = await prisma.agentTask.findUnique({ where: { id: taskId }, select: { sessionId: true } });
  if (!task) return;
  await prisma.$transaction([
    ...(options.assistantParts ? [prisma.agentMessage.create({
      data: {
        sessionId: task.sessionId,
        taskId,
        role: "ASSISTANT",
        parts: asInputJson(options.assistantParts),
      },
    })] : []),
    prisma.agentTask.updateMany({
      where: { id: taskId, status: { in: ["QUEUED", "RUNNING"] } },
      data: {
        status: options.cancelled ? "CANCELLED" : "FAILED",
        error: asInputJson(error),
        completedAt: new Date(),
      },
    }),
  ]);
}

export async function listAgentThreadMessages(
  sessionId: string,
  userId: string,
): Promise<PersistedAgentMessage[]> {
  const session = await prisma.canvasSession.findFirst({
    where: { id: sessionId, userId },
    select: { id: true },
  });
  if (!session) {
    throw new ApiError({
      status: 404,
      code: "canvas_session_not_found",
      message: "Canvas session not found.",
      retryable: false,
    });
  }

  await prisma.agentTask.updateMany({
    where: { sessionId, userId, status: "RUNNING" },
    data: { status: "INTERRUPTED", interruptedAt: new Date() },
  });

  const messages = await prisma.agentMessage.findMany({
    where: { sessionId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, role: true, parts: true },
  });

  return messages.map((message) => ({
    id: message.id,
    role: message.role === "USER" ? "user" : "assistant",
    parts: Array.isArray(message.parts)
      ? (message.parts as Array<Record<string, unknown>>)
      : [],
  }));
}
