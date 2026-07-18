import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildWorkflowPrompt, findWorkflowTemplateById, type CreativeMode } from "@/lib/prompts/creative-workflows";
import { ApiError, jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import { optimizePrompt } from "@/lib/server/prompt-optimizer";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";

const optimizePromptSchema = z.object({
  prompt: z.string().optional(),
  mode: z.string().optional(),
  referenceCount: z.number().optional(),
  templateId: z.string().optional(),
  templateTitle: z.string().optional(),
  templatePrompt: z.string().optional(),
  locale: z.string().optional(),
  generationType: z.string().optional(),
  videoModelId: z.string().optional(),
  videoDuration: z.number().optional(),
  presetName: z.string().optional(),
  presetGuidance: z.string().optional(),
});

const VALID_MODES = new Set<CreativeMode>(["general", "photo", "illustration", "concept", "background"]);
const VALID_GEN_TYPES = new Set(["image", "video"]);

function normalizeOptimizeMode(raw: unknown): CreativeMode {
  if (typeof raw === "string" && VALID_MODES.has(raw as CreativeMode)) {
    return raw as CreativeMode;
  }
  return "general";
}

export async function POST(request: NextRequest) {
  try {
    await requireLocalWorkspaceOwner();

    const body = await parseJsonBody(request, optimizePromptSchema);

    const prompt = String(body.prompt ?? "").trim();
    const locale = String(body.locale ?? "").trim() || undefined;
    const mode = normalizeOptimizeMode(body.mode);
    const referenceCount = Number.isFinite(body.referenceCount) ? Math.max(0, Number(body.referenceCount)) : 0;

    const template = findWorkflowTemplateById(body.templateId);
    const fallbackTemplateTitle = String(body.templateTitle ?? "").trim();
    const templateTitle = template?.title ?? (fallbackTemplateTitle || undefined);

    const fallbackTemplatePrompt = String(body.templatePrompt ?? "").trim();
    const templatePrompt = template ? buildWorkflowPrompt(template, mode) : fallbackTemplatePrompt || undefined;

    const generationType = VALID_GEN_TYPES.has(body.generationType ?? "")
      ? (body.generationType as "image" | "video")
      : undefined;
    const videoModelId = String(body.videoModelId ?? "").trim() || undefined;
    const videoDuration = Number.isFinite(body.videoDuration) ? Math.max(0, Number(body.videoDuration)) : undefined;
    const presetName = String(body.presetName ?? "").trim() || undefined;
    const presetGuidance = String(body.presetGuidance ?? "").trim() || undefined;

    if (!prompt && !templatePrompt) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "Prompt or template context is required.",
        retryable: false,
      });
    }

    const payload = await optimizePrompt({
      prompt: prompt || (locale?.toLowerCase().startsWith("zh") ? "请将该工作流模板优化为可直接用于 AI 生图的提示词。" : "Refine this workflow template into a production-ready prompt."),
      mode,
      templateTitle,
      templatePrompt,
      referenceCount,
      locale,
      generationType,
      videoModelId,
      videoDuration,
      presetName,
      presetGuidance,
      abortSignal: request.signal,
    });

    return NextResponse.json(payload);
  } catch (error) {
    return jsonError(error);
  }
}
