// Video model metadata helpers. Runtime-visible video rows come from the live
// BYOK catalog; static cloud rows are intentionally not shipped.

import type { ModelSourceEvidence, ModelTier } from "@/lib/image-models";

export type VideoModelSource = "local" | "byok" | "cloud";

export interface VideoModelEntry {
  id: string;
  providerModelId: string;
  brand: string;
  brandZh: string;
  label: string;
  labelZh: string;
  tier: ModelTier;
  durationMode: "discrete" | "range";
  durationOptions?: number[];
  durationRange?: [number, number];
  supportsImageInput: boolean;
  requiresImageInput: boolean;
  /**
   * Whether the duration / image-input capability above is actually verified for
   * this model. Static catalog rows are verified; a BYOK row uses a permissive
   * working default (the user's chosen model id can be anything), so it sets this
   * false and the UI presents those limits as estimates, not promises.
   */
  capabilityVerified?: boolean;
  /**
   * Where this model actually runs. Video has no local engine today, so all
   * entries are "cloud" or "byok"; the field is here for picker grouping
   * symmetry with image and forward compatibility.
   */
  source?: VideoModelSource;
  sourceEvidence?: ModelSourceEvidence[];
  freshnessExpiresAt?: string;
  freshnessNote?: string;
}

const VIDEO_FRESHNESS_BASELINE = "2026-07-03";
const VIDEO_FRESHNESS_EXPIRES_AT = "2026-08-02";

export function normalizeDuration(model: VideoModelEntry, seconds: number): number {
  if (model.durationMode === "discrete") {
    const options = model.durationOptions!;
    const safeSeconds = Number.isFinite(seconds) ? seconds : options[0]!;
    return options.reduce((best, opt) =>
      Math.abs(opt - safeSeconds) < Math.abs(best - safeSeconds) ? opt : best,
    );
  }
  const [min, max] = model.durationRange!;
  const safeSeconds = Number.isFinite(seconds) ? seconds : min;
  return Math.max(min, Math.min(max, Math.round(safeSeconds)));
}

export interface VideoPromptSkill {
  systemPrompt: string;
  outputLanguage: "zh-CN" | "en";
  supportsNegativePrompt: boolean;
  sourceEvidence: ModelSourceEvidence[];
  freshnessExpiresAt: string;
}

type VideoBrand = "generic" | "veo" | "seedance" | "kling" | "wan";
type PromptLanguage = "zh-CN" | "en";

function brandFromProviderId(providerModelId: string): VideoBrand {
  if (providerModelId.startsWith("google/veo")) return "veo";
  if (providerModelId.startsWith("bytedance/seedance")) return "seedance";
  if (providerModelId.startsWith("klingai/")) return "kling";
  if (providerModelId.startsWith("alibaba/wan")) return "wan";
  return "generic";
}

function evidence(label: string, url: string): ModelSourceEvidence[] {
  return [{ label, url, lastVerifiedAt: VIDEO_FRESHNESS_BASELINE }];
}

const VIDEO_PROMPT_SKILLS: Record<VideoBrand, Record<PromptLanguage, VideoPromptSkill>> = {
  generic: {
    "zh-CN": {
      systemPrompt: [
        "你是视频生成提示词优化专家。",
        "只输出优化后的提示词正文，不要解释。",
        "用清晰的主体、动作、场景、镜头、光影和风格描述组织提示词。",
        "不要声称模型支持负面 prompt、音频、参考图、固定时长或多镜头能力；只用正向约束表达排除项。",
      ].join(" "),
      outputLanguage: "zh-CN",
      supportsNegativePrompt: false,
      sourceEvidence: evidence("Generic BYOK video prompt fallback", "https://fal.ai/explore/text-to-video-apis"),
      freshnessExpiresAt: VIDEO_FRESHNESS_EXPIRES_AT,
    },
    en: {
      systemPrompt: [
        "You are a video prompt optimization expert.",
        "Output only the optimized prompt text, with no explanation.",
        "Structure it around subject, action, scene, camera, lighting, and style.",
        "Do not claim support for negative prompts, audio, reference images, fixed durations, or multi-shot controls; express exclusions as positive constraints.",
      ].join(" "),
      outputLanguage: "en",
      supportsNegativePrompt: false,
      sourceEvidence: evidence("Generic BYOK video prompt fallback", "https://fal.ai/explore/text-to-video-apis"),
      freshnessExpiresAt: VIDEO_FRESHNESS_EXPIRES_AT,
    },
  },
  veo: {
    "zh-CN": {
      systemPrompt: [
        "你是视频生成提示词优化专家，专精 Google Veo 模型。",
        "用户输入的是中文，但 Veo 对英文 prompt 效果最佳，你必须输出英文优化提示词。",
        "优化要求：",
        "- 结构：Subject → Action → Scene → Style → Camera，75-125 词",
        "- 每个片段只描述一个主要动作、一种镜头运动、一种光影主题",
        "- 镜头语言：dolly shot, tracking shot, crane shot, slow pan, POV 等",
        "- 画面质感：可用 shot on 35mm film, cinematic lighting, shallow depth of field 等",
        "- 当前官方 Vertex AI Veo 文档没有给这条路径暴露 negative_prompt 字段；所有排除项必须用正面描述表达",
        "- 禁止 markdown、禁止分点、禁止解释，只输出优化后的英文提示词",
      ].join(" "),
      outputLanguage: "en",
      supportsNegativePrompt: false,
      sourceEvidence: evidence("Google Cloud Veo 3.1 model docs", "https://cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate?hl=en"),
      freshnessExpiresAt: VIDEO_FRESHNESS_EXPIRES_AT,
    },
    en: {
      systemPrompt: [
        "You are a video prompt optimization expert specializing in Google Veo models.",
        "Optimize the user prompt for Veo video generation. Output only the optimized prompt in English.",
        "Structure: Subject → Action → Scene → Style → Camera, 75-125 words.",
        "One main action, one camera movement, one lighting theme per shot.",
        "Camera: dolly, tracking, crane, slow pan, POV, aerial, etc.",
        "Style: shot on 35mm film, cinematic lighting, shallow depth of field, etc.",
        "The current official Vertex AI Veo path does not expose a negative_prompt field here; express exclusions positively.",
        "No markdown, no bullet list, no explanation.",
      ].join(" "),
      outputLanguage: "en",
      supportsNegativePrompt: false,
      sourceEvidence: evidence("Google Cloud Veo 3.1 model docs", "https://cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate?hl=en"),
      freshnessExpiresAt: VIDEO_FRESHNESS_EXPIRES_AT,
    },
  },
  seedance: {
    "zh-CN": {
      systemPrompt: [
        "你是视频生成提示词优化专家，专精字节跳动 Seedance 模型。",
        "输出必须是中文，且只输出优化后的提示词正文。",
        "优化要求：",
        "- 结构：主体 → 动作 → 场景 → 镜头 → 风格 → 约束",
        "- 每个镜头只描述一个动作，一种镜头运动，不要叠加复合运动",
        "- 镜头语言：推拉摇移、固定机位、跟随、环绕、俯拍、仰拍等",
        "- 画面质感：电影感、4K、高清、胶片质感等",
        "- 当前 fal/Seedance 2.0 API schema 未列出 negative_prompt，用正面约束语句替代",
        "- 简洁精准，避免模糊词，使用电影级专业语言",
        "- 禁止 markdown、禁止分点、禁止解释",
      ].join(" "),
      outputLanguage: "zh-CN",
      supportsNegativePrompt: false,
      sourceEvidence: evidence("fal Seedance 2.0 API schema", "https://fal.ai/models/bytedance/seedance-2.0/text-to-video/api"),
      freshnessExpiresAt: VIDEO_FRESHNESS_EXPIRES_AT,
    },
    en: {
      systemPrompt: [
        "You are a video prompt optimization expert specializing in ByteDance Seedance models.",
        "Output only the optimized prompt in English.",
        "Structure: Subject → Action → Scene → Camera → Style → Constraints.",
        "One action per shot, one camera movement per shot — no compound movements.",
        "Camera: dolly in, pan, tilt, orbit, overhead, tracking, etc.",
        "Style: cinematic, 4K, high definition, film grain, etc.",
        "The current fal/Seedance 2.0 API schema does not list negative_prompt; use positive constraint statements instead.",
        "Be precise, avoid vague words. Use cinematic language.",
        "No markdown, no bullet list, no explanation.",
      ].join(" "),
      outputLanguage: "en",
      supportsNegativePrompt: false,
      sourceEvidence: evidence("fal Seedance 2.0 API schema", "https://fal.ai/models/bytedance/seedance-2.0/text-to-video/api"),
      freshnessExpiresAt: VIDEO_FRESHNESS_EXPIRES_AT,
    },
  },
  kling: {
    "zh-CN": {
      systemPrompt: [
        "你是视频生成提示词优化专家，专精快手可灵模型。",
        "输出必须是中文，且只输出优化后的提示词正文。",
        "优化要求：",
        "- 结构：主体（外貌描述）→ 运动 → 场景（场景描述）→ 镜头语言 → 光影 → 氛围",
        "- 运动描述不宜过于复杂，需符合短视频可展现的画面",
        "- 镜头语言：特写、背景虚化、长焦、航拍、景深、地面拍摄等",
        "- 光影：晨光、夕阳、丁达尔效应、氛围光照等",
        "- 每个镜头运动都应服务于叙事，指定运动终点防止失控",
        "- 未在当前官方公开资料里确认 API 级 negative_prompt 字段；把排除项改写成正向约束，不输出「负面约束」段",
        "- 禁止 markdown、禁止分点、禁止解释",
      ].join(" "),
      outputLanguage: "zh-CN",
      supportsNegativePrompt: false,
      sourceEvidence: evidence("Kling Video 3.0 official guide", "https://app.klingai.com/cn/quickstart/klingai-video-3-model-user-guide"),
      freshnessExpiresAt: VIDEO_FRESHNESS_EXPIRES_AT,
    },
    en: {
      systemPrompt: [
        "You are a video prompt optimization expert specializing in Kuaishou Kling models.",
        "Output only the optimized prompt in English.",
        "Structure: Subject (appearance) → Motion → Scene (description) → Camera → Lighting → Mood.",
        "Keep motion simple enough for short video. Each camera movement must serve the narrative.",
        "Camera: close-up, bokeh, telephoto, aerial, depth of field, ground-level, etc.",
        "Lighting: golden hour, Tyndall effect, ambient glow, etc.",
        "Current public official Kling material does not confirm an API-level negative_prompt field; rewrite exclusions as positive constraints and do not append a Negative section.",
        "No markdown, no bullet list, no explanation.",
      ].join(" "),
      outputLanguage: "en",
      supportsNegativePrompt: false,
      sourceEvidence: evidence("Kling Video 3.0 official guide", "https://app.klingai.com/cn/quickstart/klingai-video-3-model-user-guide"),
      freshnessExpiresAt: VIDEO_FRESHNESS_EXPIRES_AT,
    },
  },
  wan: {
    "zh-CN": {
      systemPrompt: [
        "你是视频生成提示词优化专家，专精阿里通义万相视频模型。",
        "输出必须是中文，且只输出优化后的提示词正文。",
        "优化要求：",
        "- 结构：主体 → 动作 → 场景 → 镜头 → 风格 → 约束",
        "- 每个镜头只描述一个动作，一种镜头运动，不要叠加复合运动",
        "- 镜头语言：推拉摇移、固定机位、跟随、环绕、俯拍、仰拍等",
        "- 画面质感：电影感、4K、高清、中国美学、水墨风等",
        "- 通义万相 API 支持 negative_prompt；如需排除项，在正文结尾用「反向提示词：」列出关键词",
        "- 禁止 markdown、禁止分点、禁止解释",
      ].join(" "),
      outputLanguage: "zh-CN",
      supportsNegativePrompt: true,
      sourceEvidence: evidence("Alibaba Cloud Wan text-to-video API reference", "https://www.alibabacloud.com/help/doc-detail/3030514.html"),
      freshnessExpiresAt: VIDEO_FRESHNESS_EXPIRES_AT,
    },
    en: {
      systemPrompt: [
        "You are a video prompt optimization expert specializing in Alibaba Wan video models.",
        "Output only the optimized prompt in English.",
        "Structure: Subject → Action → Scene → Camera → Style → Constraints.",
        "One action per shot, one camera movement per shot — no compound movements.",
        "Camera: dolly in, pan, tilt, orbit, overhead, tracking, etc.",
        "Style: cinematic, 4K, high definition, Chinese aesthetics, ink-wash style, etc.",
        "Wan API supports negative_prompt. If exclusions are needed, end with 'Negative prompt:' followed by concise keywords.",
        "No markdown, no bullet list, no explanation.",
      ].join(" "),
      outputLanguage: "en",
      supportsNegativePrompt: true,
      sourceEvidence: evidence("Alibaba Cloud Wan text-to-video API reference", "https://www.alibabacloud.com/help/doc-detail/3030514.html"),
      freshnessExpiresAt: VIDEO_FRESHNESS_EXPIRES_AT,
    },
  },
};

export function getVideoPromptSkill(
  modelOrProviderId: string,
  language: PromptLanguage,
): VideoPromptSkill {
  const brand = brandFromProviderId(modelOrProviderId);
  return VIDEO_PROMPT_SKILLS[brand][language];
}
