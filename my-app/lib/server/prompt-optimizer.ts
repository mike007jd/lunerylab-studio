// Rewrites a user prompt through the configured local model first, then BYOK.

import { ApiError } from "@/lib/server/errors";
import { generateTextLocal } from "@/lib/server/local-llm";
import { generateTextByok } from "@/lib/server/byok-llm";
import { resolveTextRuntimeSupply } from "@/lib/server/runtime-supply";
import { getVideoPromptSkill } from "@/lib/video-models";
import type { VideoPromptSkill } from "@/lib/video-models";
import type { CreativeMode } from "@/lib/prompts/creative-workflows";

interface OptimizePromptInput {
  prompt: string;
  mode: CreativeMode;
  templateTitle?: string;
  templatePrompt?: string;
  referenceCount?: number;
  locale?: string;
  generationType?: "image" | "video";
  /** Video model internal ID, used only for prompt-shaping context. */
  videoModelId?: string;
  /** Explicit bootstrap default text model (`local:…` or `byok:provider:model`). */
  textModelId?: string;
  videoDuration?: number;
  presetName?: string;
  presetGuidance?: string;
  abortSignal?: AbortSignal;
}

export interface OptimizePromptResult {
  provider: "local" | "byok";
  model: string;
  optimizedPrompt: string;
}

type PromptLanguage = "zh-CN" | "en";

function containsChinese(text: string): boolean {
  return /[㐀-鿿]/.test(text);
}

function extractChineseKeywords(text: string): string[] {
  const matches = text.match(/[㐀-鿿]{2,8}/g) ?? [];
  return Array.from(new Set(matches)).slice(0, 10);
}

function hasChineseKeywordOverlap(source: string, output: string): boolean {
  const keywords = extractChineseKeywords(source);
  if (keywords.length === 0) return true;
  return keywords.some((keyword) => output.includes(keyword));
}

function needsChineseRetry(source: string, optimizedPrompt: string): boolean {
  if (!containsChinese(optimizedPrompt)) return true;
  return !hasChineseKeywordOverlap(source, optimizedPrompt);
}

function resolvePromptLanguage({
  locale,
  prompt,
  templatePrompt,
}: {
  locale?: string;
  prompt: string;
  templatePrompt?: string;
}): PromptLanguage {
  const normalizedLocale = String(locale ?? "").toLowerCase();
  if (normalizedLocale.startsWith("zh")) return "zh-CN";
  if (containsChinese(prompt) || containsChinese(templatePrompt ?? "")) return "zh-CN";
  return "en";
}

function buildOptimizeInstruction(
  language: PromptLanguage,
  generationType?: "image" | "video",
  videoModelId?: string,
): { instruction: string; videoSkill?: VideoPromptSkill } {
  if (generationType === "video" && videoModelId) {
    const skill = getVideoPromptSkill(videoModelId, language);
    return { instruction: skill.systemPrompt, videoSkill: skill };
  }

  if (language === "zh-CN") {
    return {
      instruction: [
        "你是 AI 创意生图提示词优化专家。",
        "请将用户提示词改写为适配主流图像生成模型的高质量中文提示词。",
        "输出必须是中文，且只输出优化后的提示词正文。",
        "要求简洁、可执行、画面精致。",
        "覆盖主体、场景、构图、光线、风格、画质约束和负向约束。",
        "禁止 markdown、禁止分点、禁止解释。",
      ].join(" "),
    };
  }

  return {
    instruction: [
      "You are an expert AI image prompt optimizer.",
      "Rewrite the user prompt for production-grade image generation.",
      "Output only the optimized prompt text in English.",
      "Keep it concise, production-ready, and visually refined.",
      "Include: subject, environment, composition, lighting, style, quality constraints, and negative constraints.",
      "No markdown, no bullet list, no explanation.",
    ].join(" "),
  };
}

function buildOptimizeContext({
  language,
  mode,
  referenceCount,
  templateTitle,
  templatePrompt,
  prompt,
  generationType,
  videoDuration,
  presetName,
  presetGuidance,
}: {
  language: PromptLanguage;
  mode: OptimizePromptInput["mode"];
  referenceCount: number;
  templateTitle?: string;
  templatePrompt?: string;
  prompt: string;
  generationType?: "image" | "video";
  videoDuration?: number;
  presetName?: string;
  presetGuidance?: string;
}): string {
  const modeLabel =
    language === "zh-CN"
      ? {
          general: "通用创作",
          photo: "摄影画面",
          illustration: "插画创作",
          concept: "概念视觉",
          background: "背景生成",
        }[mode]
      : {
          general: "General creative",
          photo: "Photography",
          illustration: "Illustration",
          concept: "Concept visual",
          background: "Background generation",
        }[mode];
  if (language === "zh-CN") {
    return [
      `模式：${modeLabel}`,
      generationType === "video" ? "生成类型：视频" : "生成类型：图像",
      `参考图数量：${referenceCount}`,
      videoDuration != null ? `视频时长：${videoDuration}秒` : "",
      templateTitle ? `模板名称：${templateTitle}` : "",
      templatePrompt ? `模板上下文：${templatePrompt}` : "",
      presetName ? `风格预设：${presetName}` : "",
      presetGuidance ? `预设指引：${presetGuidance}` : "",
      `用户原始提示词：${prompt}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `Mode: ${modeLabel}`,
    generationType === "video" ? "Generation type: video" : "Generation type: image",
    `Reference images: ${referenceCount}`,
    videoDuration != null ? `Video duration: ${videoDuration}s` : "",
    templateTitle ? `Template: ${templateTitle}` : "",
    templatePrompt ? `Template context: ${templatePrompt}` : "",
    presetName ? `Style preset: ${presetName}` : "",
    presetGuidance ? `Preset guidance: ${presetGuidance}` : "",
    `User prompt: ${prompt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

interface TextBackendAttempt {
  backend: "local" | "byok";
  model: string;
  run: () => Promise<{ text: string; model: string }>;
  /** Re-run this backend with a different user prompt (e.g. a corrective retry). */
  runWith: (userPrompt: string) => Promise<{ text: string; model: string }>;
}

async function planAttempts(
  instruction: string,
  context: string,
  textModelId: string | undefined,
  abortSignal?: AbortSignal,
): Promise<TextBackendAttempt[]> {
  const attempts: TextBackendAttempt[] = [];
  // Exact selection only — never enumerate an unrelated first BYOK candidate.
  const supply = await resolveTextRuntimeSupply(textModelId).catch(() => null);

  // Local-first: only enqueue when the supply layer found a reachable
  // endpoint and a loaded model for the explicit default.
  if (supply?.backend === "local" && supply.endpoint && supply.modelId) {
    const endpoint = supply.endpoint;
    const modelId = supply.modelId;
    attempts.push({
      backend: "local",
      model: modelId,
      run: () =>
        generateTextLocal({
          systemPrompt: instruction,
          userPrompt: context,
          endpoint,
          modelId,
          temperature: 0.4,
          abortSignal,
        }),
      runWith: (userPrompt) =>
        generateTextLocal({
          systemPrompt: instruction,
          userPrompt,
          endpoint,
          modelId,
          temperature: 0.4,
          abortSignal,
        }),
    });
  }

  if (supply?.backend === "byok" && supply.providerId) {
    const providerId = supply.providerId;
    const modelId = supply.modelId;
    attempts.push({
      backend: "byok",
      model: modelId ?? providerId,
      run: () =>
        generateTextByok({
          systemPrompt: instruction,
          userPrompt: context,
          providerId,
          modelId,
          temperature: 0.4,
          abortSignal,
        }),
      runWith: (userPrompt) =>
        generateTextByok({
          systemPrompt: instruction,
          userPrompt,
          providerId,
          modelId,
          temperature: 0.4,
          abortSignal,
        }),
    });
  }

  return attempts;
}

export async function optimizePrompt({
  prompt,
  mode,
  templateTitle,
  templatePrompt,
  referenceCount = 0,
  locale,
  generationType,
  videoModelId,
  textModelId,
  videoDuration,
  presetName,
  presetGuidance,
  abortSignal,
}: OptimizePromptInput): Promise<OptimizePromptResult> {
  const language = resolvePromptLanguage({ locale, prompt, templatePrompt });
  const { instruction, videoSkill } = buildOptimizeInstruction(language, generationType, videoModelId);
  const context = buildOptimizeContext({
    language,
    mode,
    referenceCount,
    templateTitle,
    templatePrompt,
    prompt,
    generationType,
    videoDuration,
    presetName,
    presetGuidance,
  });
  const sourceForValidation = [prompt, templatePrompt].filter(Boolean).join("\n");

  const attempts = await planAttempts(instruction, context, textModelId, abortSignal);

  // Tier walk: try each backend in order. On any error, advance to the next.
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const first = await attempt.run();
      let optimizedPrompt = first.text;
      let resolvedModel = first.model;

      const skipChineseRetry = videoSkill?.outputLanguage === "en";
      if (language === "zh-CN" && !skipChineseRetry && needsChineseRetry(sourceForValidation, optimizedPrompt)) {
        const keywords = extractChineseKeywords(prompt).slice(0, 6);
        const keywordLine = keywords.length > 0
          ? `必须保留这些关键词：${keywords.join("、")}。`
          : "必须与用户原始提示词语义一致。";
        try {
          const newContext = [
            context,
            "",
            "重要：你上一轮输出不符合要求。",
            "请仅输出中文优化提示词，不要解释、不要分点。",
            keywordLine,
          ].join("\n");
          const retryWithKeywordContext = await attempt.runWith(newContext);
          optimizedPrompt = retryWithKeywordContext.text;
          resolvedModel = retryWithKeywordContext.model;
        } catch {
          // The next configured backend still gets a chance below.
        }

        if (needsChineseRetry(sourceForValidation, optimizedPrompt)) {
          throw new ApiError({
            status: 502,
            code: "prompt_optimizer_invalid_output",
            message: "Prompt refinement returned an invalid result. Try again or check the text runtime.",
            retryable: true,
          });
        }
      }

      if (!optimizedPrompt) {
        throw new ApiError({
          status: 502,
          code: "empty_text_result",
          message: "Prompt optimizer returned no text.",
          retryable: false,
        });
      }

      return {
        provider: attempt.backend,
        model: resolvedModel,
        optimizedPrompt,
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof ApiError) throw lastError;
  throw new ApiError({
    status: 503,
    code: "prompt_optimizer_unavailable",
    message: "Prompt refinement is unavailable. Check the text runtime in Settings.",
    retryable: true,
  });
}
