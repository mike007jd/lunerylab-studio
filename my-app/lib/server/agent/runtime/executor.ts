/**
 * Agent runtime executor.
 *
 * Drives a multi-step agent loop with the AI SDK:
 *   1. Resolve runtime supply (text + image backend).
 *   2. Build a canvas snapshot + system prompt.
 *   3. Instantiate the toolset bound to a mutable context.
 *   4. Run `generateText` with `stopWhen` and tools; each tool execute()
 *      records a step and possibly mutates the canvas.
 *   5. Use the final text returned by AI SDK. If the agent returns no final
 *      text, surface a visible error except for the explicit step-budget stop.
 *
 * Returns the full step history + artifacts so the UI can render a timeline
 * and pick up generated assets.
 */

import "server-only";
import { stepCountIs, streamText } from "ai";
import { randomUUID } from "node:crypto";
import { detectLocaleFromAcceptLanguage, isChineseLocale } from "@/lib/i18n/locale";
import { resolveStudioRuntimeSupply } from "@/lib/server/runtime-supply";
import { resolveAgentLanguageModel } from "@/lib/server/agent/runtime/resolve-language-model";
import {
  buildCanvasSnapshot,
  renderCanvasSnapshot,
} from "@/lib/server/agent/runtime/canvas-serializer";
import { buildAgentSystemPrompt } from "@/lib/server/agent/runtime/system-prompt";
import { buildAgentToolset, type AgentToolContext } from "@/lib/server/agent/runtime/tool-registry";
import { getModelCatalog } from "@/lib/server/model-catalog";
import { ApiError } from "@/lib/server/errors";
import { prisma } from "@/lib/server/prisma";
import { saveCanvasSnapshot } from "@/lib/server/canvas-snapshot";
import type {
  AgentRunInput,
  AgentRunResult,
  AgentStep,
  AgentStepArtifacts,
} from "@/lib/server/agent/runtime/types";

type ExecutableTool = {
  execute?: (input: Record<string, unknown>) => Promise<unknown> | unknown;
};

type RunError = { code?: string; message: string };

const DEFAULT_MAX_STEPS = 12;
// Absolute ceiling regardless of any caller-supplied maxSteps.
const HARD_MAX_STEPS = 24;
// Overall wall-clock budget for a single agent turn. Leave room under the
// route maxDuration for the UIMessage stream to flush its visible error/finish.
const RUN_DEADLINE_MS = 285 * 1000;

function abortErrorMessage(locale: ReturnType<typeof detectLocaleFromAcceptLanguage>): string {
  return isChineseLocale(locale) ? "已停止。" : "Stopped.";
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Agent run aborted.", "AbortError");
}

function sanitizePromptFragment(
  value: string | null | undefined,
  fallback: string,
  maxLength = 200,
): string {
  const cleaned = value
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function sanitizeAssetId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /^[A-Za-z0-9_-]{8,80}$/.test(trimmed) ? trimmed : null;
}

function mergeArtifacts(target: AgentStepArtifacts, addition: AgentStepArtifacts): void {
  if (addition.generatedAssetIds?.length) {
    target.generatedAssetIds = [
      ...(target.generatedAssetIds ?? []),
      ...addition.generatedAssetIds,
    ];
  }
  if (addition.createdLayerIds?.length) {
    target.createdLayerIds = [
      ...(target.createdLayerIds ?? []),
      ...addition.createdLayerIds,
    ];
  }
  if (addition.modifiedLayerIds?.length) {
    target.modifiedLayerIds = [
      ...(target.modifiedLayerIds ?? []),
      ...addition.modifiedLayerIds,
    ];
  }
  if (addition.videoJobId) {
    target.videoJobId = addition.videoJobId;
  }
}

async function attachTaskProvenance({
  taskId,
  userId,
  sessionId,
  steps,
  artifacts,
}: {
  taskId: string;
  userId: string;
  sessionId: string;
  steps: AgentStep[];
  artifacts: AgentStepArtifacts;
}): Promise<void> {
  const assetIds = Array.from(new Set(artifacts.generatedAssetIds ?? []));
  const createdLayerIds = Array.from(new Set(artifacts.createdLayerIds ?? []));
  const sourceLayerIds = Array.from(
    new Set(
      steps.flatMap((step) => {
        const layerId = step.input?.layerId;
        return typeof layerId === "string" ? [layerId] : [];
      }),
    ),
  );
  const sourceLayers = sourceLayerIds.length
    ? await prisma.canvasLayer.findMany({
        where: { id: { in: sourceLayerIds }, sessionId },
        select: { id: true, assetId: true },
      })
    : [];
  const sourceAssetByLayer = new Map(sourceLayers.map((layer) => [layer.id, layer.assetId]));

  const writes = steps.flatMap((step) => {
    const generatedIds = step.artifacts.generatedAssetIds ?? [];
    if (generatedIds.length === 0) return [];
    const sourceLayerId = typeof step.input?.layerId === "string" ? step.input.layerId : null;
    return [
      prisma.asset.updateMany({
        where: { id: { in: generatedIds }, userId },
        data: {
          agentTaskId: taskId,
          summary: step.summary.slice(0, 280),
          ...(sourceLayerId && sourceAssetByLayer.has(sourceLayerId)
            ? { parentAssetId: sourceAssetByLayer.get(sourceLayerId) }
            : {}),
        },
      }),
    ];
  });

  if (createdLayerIds.length > 0) {
    writes.push(
      prisma.canvasLayer.updateMany({
        where: { id: { in: createdLayerIds }, sessionId },
        data: { agentTaskId: taskId },
      }),
    );
  }
  if (assetIds.length > 0 || artifacts.videoJobId) {
    writes.push(
      prisma.generationJob.updateMany({
        where: {
          userId,
          OR: [
            ...(assetIds.length > 0 ? [{ assets: { some: { id: { in: assetIds } } } }] : []),
            ...(artifacts.videoJobId ? [{ id: artifacts.videoJobId }] : []),
          ],
        },
        data: { agentTaskId: taskId },
      }),
    );
  }
  if (writes.length > 0) await prisma.$transaction(writes);
}

function readToolError(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const value = result as { ok?: unknown; error?: unknown };
  if (value.ok !== false) return null;
  return typeof value.error === "string" && value.error.trim()
    ? value.error.trim()
    : "The requested action failed.";
}

function readToolSummary(result: unknown, fallback: string): string {
  if (!result || typeof result !== "object") return fallback;
  const summary = (result as { summary?: unknown }).summary;
  return typeof summary === "string" && summary.trim() ? summary.trim() : fallback;
}

function unavailableToolResult(toolName: string): { message: string; error: RunError } {
  const message = `Agent tool "${toolName}" is unavailable.`;
  return { message, error: { code: "agent_tool_unavailable", message } };
}

function genericRunErrorMessage(
  locale: ReturnType<typeof detectLocaleFromAcceptLanguage>,
): string {
  return isChineseLocale(locale)
    ? "执行时出错了，请重试或调整你的指令。"
    : "Something went wrong during the run. Try again or rephrase.";
}

function toRunError(
  error: unknown,
  locale: ReturnType<typeof detectLocaleFromAcceptLanguage>,
): RunError {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message };
  }
  return { message: genericRunErrorMessage(locale) };
}

async function runDeterministicAction(
  tools: Record<string, unknown>,
  action: NonNullable<AgentRunInput["action"]>,
): Promise<{ message: string; error?: RunError }> {
  if (action.type === "inpaint_layer") {
    const tool = tools.inpaint_layer as ExecutableTool | undefined;
    if (!tool?.execute) return unavailableToolResult("inpaint_layer");
    const result = await tool.execute({
      layerId: action.layerId,
      prompt: action.prompt,
    });
    const error = readToolError(result);
    if (error) return { message: error, error: { message: error } };
    return { message: readToolSummary(result, `Inpainted layer ${action.layerId}.`) };
  }

  const tool = tools.remove_background as ExecutableTool | undefined;
  if (!tool?.execute) return unavailableToolResult("remove_background");
  const result = await tool.execute({ layerId: action.layerId });
  const error = readToolError(result);
  if (error) return { message: error, error: { message: error } };
  return { message: readToolSummary(result, `Removed background of layer ${action.layerId}.`) };
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const runId = randomUUID();
  const startMs = Date.now();
  const locale = input.locale ?? detectLocaleFromAcceptLanguage(null);
  // Clamp the step budget to a hard ceiling — never trust a caller-supplied value.
  const maxSteps = Math.max(1, Math.min(input.maxSteps ?? DEFAULT_MAX_STEPS, HARD_MAX_STEPS));
  // Merge the caller's abort signal with an overall wall-clock deadline so a run
  // can't hang indefinitely on a slow tool/provider poll.
  const timeoutSignal = AbortSignal.timeout(RUN_DEADLINE_MS);
  const runSignal = input.abortSignal
    ? AbortSignal.any([input.abortSignal, timeoutSignal])
    : timeoutSignal;
  throwIfAborted(runSignal);

  // Step 0: snapshot + supply + model catalog.
  const [snapshot, supply, catalog] = await Promise.all([
    buildCanvasSnapshot(input.sessionId, input.userId, input.selectedLayerId),
    resolveStudioRuntimeSupply({
      textModelId: input.uiContext.selectedTextModelId,
      imageModelId: input.uiContext.selectedModelId,
    }),
    getModelCatalog(),
  ]);

  if (!snapshot) {
    throw new ApiError({
      status: 404,
      code: "canvas_session_not_found",
      message: "Canvas session not found.",
      retryable: false,
    });
  }

  const beforeSnapshot = input.taskId
    ? await saveCanvasSnapshot({
        sessionId: input.sessionId,
        label: "Before Luna task",
        isAutomatic: true,
      })
    : null;
  if (beforeSnapshot && input.taskId) {
    await prisma.agentTask.updateMany({
      where: { id: input.taskId, userId: input.userId, sessionId: input.sessionId },
      data: { beforeSnapshotId: beforeSnapshot.id },
    });
  }

  // Bail only when NO backend can serve the request — neither text (for
  // planning) nor image (for deterministic edits). A user who configured only
  // image editing must still be able to run inpaint / remove-background, so we
  // no longer reject on text-backend === "none" alone; the text LLM is resolved
  // lazily in the free-text branch below.
  if (supply.generationBackend === "none" && supply.imageBackend === "none") {
    const missingMsg = isChineseLocale(locale)
      ? "暂无可用的生成后端。请在设置中配置 Provider 或本地 Runtime。"
      : "No generation backend is available. Configure a provider or local runtime in Settings.";
    return {
      runId,
      assistantMessage: missingMsg,
      steps: [],
      artifacts: {},
      backendUsed: supply.backendUsed,
      generationBackend: supply.generationBackend,
      imageBackend: supply.imageBackend,
      capabilityFix: input.action ? supply.image.fix : (supply.text.fix ?? supply.image.fix),
      durationMs: Date.now() - startMs,
      stoppedByBudget: false,
      beforeSnapshotId: beforeSnapshot?.id,
    };
  }

  // Step recording state — mutated by tools through closure.
  const steps: AgentStep[] = [];
  const aggregatedArtifacts: AgentStepArtifacts = {};
  let stepCounter = 0;
  let finalMessage = "";
  let runError: RunError | undefined;

  const availableModels = {
    image: catalog.imageModels.map((m) => ({
      id: m.id,
      label: m.label,
      supportsEdit: m.supportsEdit,
    })),
    video: catalog.videoModels.map((m) => ({
      id: m.id,
      label: m.label,
    })),
  };

  const safeRegion = input.region
    ? {
        ...input.region,
        positionHint: sanitizePromptFragment(input.region.positionHint, "the marked area"),
      }
    : null;
  const safeMaskAssetId = sanitizeAssetId(input.maskAssetId);

  let snapshotRefreshQueue: Promise<void> = Promise.resolve();
  const ctx: AgentToolContext = {
    taskId: input.taskId,
    userId: input.userId,
    sessionId: input.sessionId,
    projectId: snapshot.projectId,
    locale,
    region: safeRegion,
    maskAssetId: safeMaskAssetId,
    abortSignal: runSignal,
    uiContext: input.uiContext,
    supply,
    snapshot,
    refreshSnapshot: () => {
      snapshotRefreshQueue = snapshotRefreshQueue
        .catch(() => undefined)
        .then(async () => {
          const fresh = await buildCanvasSnapshot(input.sessionId, input.userId, ctx.snapshot.selectedLayerId);
          if (fresh) ctx.snapshot = fresh;
        });
      return snapshotRefreshQueue;
    },
    recordStep: (step) => {
      if (runSignal.aborted) {
        return;
      }
      steps.push(step);
      // Fire optional observer for streaming routes. Wrapped in try so a
      // misbehaving consumer can never break the agent run.
      try {
        input.onStep?.(step);
      } catch {
        // ignore observer errors
      }
    },
    collectArtifacts: (artifacts) => mergeArtifacts(aggregatedArtifacts, artifacts),
    nextStepIndex: () => stepCounter++,
  };

  const tools = buildAgentToolset(ctx);
  const systemPrompt = buildAgentSystemPrompt({
    locale,
    uiContext: input.uiContext,
    canvasSnapshotText: renderCanvasSnapshot(snapshot),
    availableModels,
  });

  // Inject the marked region into the user prompt if present — the agent uses
  // it as an implicit edit constraint when calling edit_layer.
  const regionLine = safeRegion
    ? `\n\nUser also marked a region on the canvas: ${safeRegion.positionHint} (bbox=${JSON.stringify(safeRegion.bbox)}). If the user is asking to change this region, call edit_layer or inpaint_layer with the selected/relevant layerId.`
    : "";
  const maskLine = safeMaskAssetId
    ? `\n\nUser provided an uploaded black/white inpaint mask asset (${safeMaskAssetId}). If the user asks to inpaint, call inpaint_layer; the tool will use this mask from context.`
    : "";

  let stoppedByBudget = false;
  try {
    throwIfAborted(runSignal);
    if (input.action) {
      // Deterministic action (inpaint / remove-background) — only needs the
      // image-edit tool, never a text LLM. Run it without resolving a model so
      // an image-only setup works.
      const actionResult = await runDeterministicAction(tools, input.action);
      finalMessage = actionResult.message;
      runError = actionResult.error;
    } else if (supply.generationBackend === "none") {
      // Open-ended planning needs a text model; an image-only setup can't plan.
      finalMessage = isChineseLocale(locale)
        ? "暂无可用的文本模型来规划这次对话。请在设置中配置文本 Provider 或本地 Runtime。"
        : "No text model is available to plan this request. Configure a text provider or local runtime in Settings.";
      if (supply.capabilityFix) runError = { message: finalMessage };
    } else {
      // Resolve the language model lazily — only the free-text planner needs it.
      const { model } = await resolveAgentLanguageModel(supply);
      const result = streamText({
        model,
        system: systemPrompt,
        prompt: `${input.message}${regionLine}${maskLine}`,
        tools,
        stopWhen: stepCountIs(maxSteps),
        // Slightly higher temperature lets the planner explore multi-step paths.
        temperature: 0.3,
        // Cap per-step output so a runaway planner can't burn 32k+ tokens
        // describing what it intends to do next. 4096 is enough for a multi-step
        // plan with summaries; tool-call payloads are unaffected.
        maxOutputTokens: 4096,
        abortSignal: runSignal,
      });
      for await (const part of result.fullStream) {
        if (part.type === "text-delta" && part.text) {
          input.onTextDelta?.(part.text);
        }
      }
      const text = (await result.text).trim();
      if (text) finalMessage = text;
    }
  } catch (error) {
    // Hard model error — surface as a synthesized final message.
    if (isAbortError(error)) {
      // Distinguish a user stop from the wall-clock deadline firing.
      const userAborted = input.abortSignal?.aborted ?? false;
      finalMessage = userAborted
        ? abortErrorMessage(locale)
        : isChineseLocale(locale)
          ? "运行超时，已停止。"
          : "The run timed out and was stopped.";
      if (!userAborted) runError = { code: "agent_timeout", message: finalMessage };
    } else {
      console.error(`[agent:${runId}] run error:`, error);
      runError = toRunError(error, locale);
      finalMessage = runError.message;
    }
  }

  if (!finalMessage && steps.length >= maxSteps) {
    stoppedByBudget = true;
    finalMessage = isChineseLocale(locale)
      ? "我已达到本轮步骤上限并停止。已完成的操作保留在画布中；你可以继续给我下一步指令。"
      : "I reached this turn's step limit and stopped. Completed changes remain on the canvas; tell me the next step.";
  }

  if (!finalMessage) {
    finalMessage = isChineseLocale(locale)
      ? "模型没有返回最终回复。请重试。"
      : "The model did not return a final response. Please retry.";
    runError = { code: "agent_empty_final", message: finalMessage };
  }

  if (input.taskId) {
    await attachTaskProvenance({
      taskId: input.taskId,
      userId: input.userId,
      sessionId: input.sessionId,
      steps,
      artifacts: aggregatedArtifacts,
    });
  }

  const capabilityFix = input.action
    ? (supply.image.backend === "none" ? supply.image.fix : undefined)
    : supply.text.backend === "none"
      ? supply.text.fix
      : supply.image.backend === "none" &&
          steps.some((step) => step.category === "generation" && step.status === "failed")
        ? supply.image.fix
        : undefined;

  // Persist last-touched timestamp so the canvas-session list sorts naturally.
  await prisma.canvasSession
    .updateMany({
      where: { id: input.sessionId, userId: input.userId },
      data: { updatedAt: new Date() },
    })
    .catch(() => {});

  // Auto-snapshot when the run actually mutated the canvas. Keeps runs
  // reversible without bloating the snapshot list for pure chat turns.
  const touchedCanvas = Boolean(
    aggregatedArtifacts.createdLayerIds?.length ||
      aggregatedArtifacts.modifiedLayerIds?.length,
  );
  if (touchedCanvas) {
    const generationCount =
      (aggregatedArtifacts.createdLayerIds?.length ?? 0) +
      (aggregatedArtifacts.modifiedLayerIds?.length ?? 0);
    await saveCanvasSnapshot({
      sessionId: input.sessionId,
      label: `Agent run (${generationCount} change${generationCount === 1 ? "" : "s"})`,
      isAutomatic: true,
    }).catch(() => {});
  }

  return {
    runId,
    assistantMessage: finalMessage,
    steps,
    artifacts: aggregatedArtifacts,
    backendUsed: supply.backendUsed,
    generationBackend: supply.generationBackend,
    imageBackend: supply.imageBackend,
    capabilityFix,
    error: runError,
    durationMs: Date.now() - startMs,
    stoppedByBudget,
    beforeSnapshotId: beforeSnapshot?.id,
  };
}
