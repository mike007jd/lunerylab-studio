// Shared metadata for the BYOK providers supported by the Studio desktop
// runtime. Acts as the single source of truth for:
//   - Settings UI (which fields to show, what default endpoints look like)
//   - tryResolveByok in runtime-supply.ts (filtering by capability)
//   - byok-image.ts (dispatch by imageApiMode)
//   - byok-video.ts (dispatch by videoApiMode)
//   - byok-3d.ts   (dispatch by modelApiMode)
//   - byok-llm.ts  (text-capable dispatch)
//
// This module is browser-safe. Do NOT import "server-only" here.

export type ByokCapability =
  | "text"
  | "image"
  | "image-edit"
  | "video"
  | "model-3d";

export type ByokImageApiMode =
  | "openai-rest"
  | "replicate"
  | "fal"
  | "openai-compatible"
  | "none";

export type ByokVideoApiMode = "fal" | "replicate" | "minimax" | "none";

export type ByokModel3dApiMode = "fal" | "meshy" | "tripo" | "replicate" | "none";

export interface ByokProviderMeta {
  id: string;
  label: string;
  defaultEndpoint: string;
  capabilities: ByokCapability[];
  requiresEndpoint: boolean;
  requiresModelId: boolean;
  /**
   * UI-only example string shown as an input placeholder in Settings. NEVER
   * used as a runtime fallback — empty stays empty per the no-default-model
   * rule. If the user opens the form and leaves the model id blank, the BYOK
   * dispatch throws `byok_not_configured`.
   */
  placeholderModelId?: string;
  placeholderModelNote?: string;
  sourceEvidence: {
    label: string;
    url: string;
    lastVerifiedAt: string;
  };
  freshnessExpiresAt: string;
  /**
   * For providers whose "model" is a single fixed operation mode rather than a
   * user choice (Meshy `image-to-3d`, Tripo `image_to_model`). The runtime
   * uses this as a job tag for telemetry, not as a substitution for a user
   * pick. Only set on providers that genuinely have no model selection.
   */
  fixedModel3dOperation?: string;
  model3dDefaultParams?: {
    aiModel?: string;
    modelVersion?: string;
    note: string;
    sourceEvidence: {
      label: string;
      url: string;
      lastVerifiedAt: string;
    };
  };
  imageApiMode: ByokImageApiMode;
  /** Defaults to "none" so existing providers don't accidentally accept video. */
  videoApiMode?: ByokVideoApiMode;
  /** Defaults to "none" so existing providers don't accidentally accept 3D. */
  modelApiMode?: ByokModel3dApiMode;
  /**
   * fal-style inpaint / bg-remove / controlnet model ids the agent can pick by
   * name. Each entry is a fal model path with a known input schema.
   */
  imageEditModels?: {
    inpaint?: string;
    backgroundRemove?: string;
  };
}

export const BYOK_PROVIDERS: ByokProviderMeta[] = [
  {
    id: "openai",
    label: "OpenAI",
    defaultEndpoint: "https://api.openai.com/v1",
    capabilities: ["text", "image", "image-edit"],
    requiresEndpoint: false,
    // No hardcoded default model: the user must pick one (e.g. gpt-image-2
    // for images, a current chat model for text). DALL·E was deprecated and
    // scheduled to stop receiving support on 2026-05-12,
    // and silently routing to any model the user did not choose is wrong for a
    // BYOK product — empty stays empty until the user fills it in.
    requiresModelId: true,
    // GPT Image 2 is OpenAI's current state-of-the-art image model (default),
    // verified 2026-07-03; gpt-image-1.5 / gpt-image-1 remain available but are
    // no longer the recommendation.
    placeholderModelId: "gpt-image-2",
    placeholderModelNote: "Current OpenAI image model (GPT Image 2); text models still require the user's explicit choice.",
    sourceEvidence: {
      label: "OpenAI GPT Image 2 model docs",
      url: "https://developers.openai.com/api/docs/models/gpt-image-2",
      lastVerifiedAt: "2026-07-03",
    },
    freshnessExpiresAt: "2026-08-02",
    imageApiMode: "openai-rest",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    defaultEndpoint: "https://api.anthropic.com",
    capabilities: ["text"],
    requiresEndpoint: false,
    requiresModelId: true,
    placeholderModelId: "claude-sonnet-4-6",
    placeholderModelNote: "Balanced current Claude text model; Opus 4.8 is the high-end option.",
    sourceEvidence: {
      label: "Anthropic Claude models overview",
      url: "https://platform.claude.com/docs/en/about-claude/models/overview",
      lastVerifiedAt: "2026-07-03",
    },
    freshnessExpiresAt: "2026-08-02",
    imageApiMode: "none",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    defaultEndpoint: "https://generativelanguage.googleapis.com",
    capabilities: ["text"],
    requiresEndpoint: false,
    requiresModelId: true,
    placeholderModelId: "gemini-3.1-pro-preview",
    placeholderModelNote: "Current Gemini Pro preview model code from Google AI model list.",
    sourceEvidence: {
      label: "Google Gemini models",
      url: "https://ai.google.dev/gemini-api/docs/gemini-3?hl=en",
      lastVerifiedAt: "2026-07-03",
    },
    freshnessExpiresAt: "2026-08-02",
    imageApiMode: "none",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    defaultEndpoint: "https://openrouter.ai/api/v1",
    capabilities: ["text"],
    requiresEndpoint: false,
    requiresModelId: true,
    placeholderModelId: "anthropic/claude-sonnet-4.6",
    placeholderModelNote: "OpenRouter catalog is live; this is a current text example, not a runtime fallback.",
    sourceEvidence: {
      label: "OpenRouter live Models API",
      url: "https://openrouter.ai/api/v1/models",
      lastVerifiedAt: "2026-07-03",
    },
    freshnessExpiresAt: "2026-08-02",
    imageApiMode: "none",
  },
  {
    id: "minimax",
    label: "MiniMax",
    defaultEndpoint: "https://api.minimax.io/v1",
    capabilities: ["text", "video"],
    requiresEndpoint: false,
    requiresModelId: true,
    placeholderModelId: "MiniMax-Hailuo-2.3",
    placeholderModelNote: "Current standard MiniMax video model from the official API docs; text model IDs should be copied from MiniMax's own docs/account.",
    sourceEvidence: {
      label: "MiniMax video generation API reference",
      url: "https://platform.minimax.io/docs/api-reference/video-generation-t2v",
      lastVerifiedAt: "2026-07-17",
    },
    freshnessExpiresAt: "2026-08-16",
    imageApiMode: "none",
    videoApiMode: "minimax",
  },
  {
    id: "replicate",
    label: "Replicate",
    defaultEndpoint: "https://api.replicate.com/v1",
    capabilities: ["image", "image-edit", "video", "model-3d"],
    requiresEndpoint: false,
    requiresModelId: true,
    placeholderModelId: "black-forest-labs/flux-2-pro",
    placeholderModelNote: "FLUX.1 schnell is now compatibility; Replicate's FLUX collection lists FLUX.2 models as current featured options.",
    sourceEvidence: {
      label: "Replicate FLUX.2 Pro model page",
      url: "https://replicate.com/black-forest-labs/flux-2-pro",
      lastVerifiedAt: "2026-07-03",
    },
    freshnessExpiresAt: "2026-08-02",
    imageApiMode: "replicate",
    videoApiMode: "replicate",
    modelApiMode: "replicate",
  },
  {
    id: "fal",
    label: "Fal",
    defaultEndpoint: "https://queue.fal.run",
    capabilities: ["image", "image-edit", "video", "model-3d"],
    requiresEndpoint: false,
    requiresModelId: true,
    placeholderModelId: "fal-ai/flux-pro/v1.1",
    placeholderModelNote: "Current fal text-to-image example. Edit/background endpoints are separate explicit model IDs below.",
    sourceEvidence: {
      label: "fal FLUX 1.1 Pro API docs",
      url: "https://fal.ai/models/fal-ai/flux-pro/v1.1/api",
      lastVerifiedAt: "2026-07-03",
    },
    freshnessExpiresAt: "2026-08-02",
    imageApiMode: "fal",
    videoApiMode: "fal",
    modelApiMode: "fal",
    imageEditModels: {
      inpaint: "fal-ai/flux-pro/v1/fill",
      backgroundRemove: "fal-ai/birefnet",
    },
  },
  {
    id: "together",
    label: "Together AI",
    defaultEndpoint: "https://api.together.xyz/v1",
    capabilities: ["text", "image"],
    requiresEndpoint: false,
    requiresModelId: true,
    placeholderModelId: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    placeholderModelNote: "Together model availability is account/catalog specific; this is a compatibility placeholder only.",
    sourceEvidence: {
      label: "Together Llama 3.3 70B model page",
      url: "https://www.together.ai/models/llama-3-3-70b",
      lastVerifiedAt: "2026-07-03",
    },
    freshnessExpiresAt: "2026-08-02",
    imageApiMode: "openai-compatible",
  },
  {
    id: "fireworks",
    label: "Fireworks",
    defaultEndpoint: "https://api.fireworks.ai/inference/v1",
    capabilities: ["text", "image"],
    requiresEndpoint: false,
    requiresModelId: true,
    placeholderModelId: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    placeholderModelNote: "Older llama-v3p1 examples are compatibility-only; user must copy an available Fireworks model ID.",
    sourceEvidence: {
      label: "Fireworks Llama v3.3 70B model page",
      url: "https://fireworks.ai/models/fireworks/llama-v3p3-70b-instruct",
      lastVerifiedAt: "2026-07-03",
    },
    freshnessExpiresAt: "2026-08-02",
    imageApiMode: "openai-compatible",
  },
  {
    id: "meshy",
    label: "Meshy",
    defaultEndpoint: "https://api.meshy.ai/openapi",
    capabilities: ["model-3d"],
    requiresEndpoint: false,
    requiresModelId: false,
    // Operation mode — not a user-chosen model. Used as a job tag only.
    fixedModel3dOperation: "image-to-3d",
    model3dDefaultParams: {
      aiModel: "latest",
      note: "Uses Meshy's documented latest alias instead of pinning a dated model family; callers may override for reproducibility.",
      sourceEvidence: {
        label: "Meshy Image to 3D API parameters",
        url: "https://docs.meshy.ai/api/image-to-3d",
        lastVerifiedAt: "2026-07-03",
      },
    },
    sourceEvidence: {
      label: "Meshy OpenAPI docs",
      url: "https://docs.meshy.ai/api/image-to-3d",
      lastVerifiedAt: "2026-07-03",
    },
    freshnessExpiresAt: "2026-08-02",
    imageApiMode: "none",
    modelApiMode: "meshy",
  },
  {
    id: "tripo",
    label: "Tripo",
    defaultEndpoint: "https://api.tripo3d.ai/v2/openapi",
    capabilities: ["model-3d"],
    requiresEndpoint: false,
    requiresModelId: false,
    // Operation mode — not a user-chosen model. Used as a job tag only.
    fixedModel3dOperation: "image_to_model",
    model3dDefaultParams: {
      modelVersion: "v2.5-20250123",
      note: "Current Tripo image_to_model snapshot used only for the fixed 3D operation; callers may override for reproducibility.",
      sourceEvidence: {
        label: "Tripo SDK image_to_model model_version parameter",
        url: "https://github.com/VAST-AI-Research/tripo-python-sdk/blob/master/docs/API.md",
        lastVerifiedAt: "2026-07-03",
      },
    },
    sourceEvidence: {
      label: "Tripo image-to-model API docs",
      url: "https://platform.tripo3d.ai/docs/api-reference/task/image-to-model",
      lastVerifiedAt: "2026-07-03",
    },
    freshnessExpiresAt: "2026-08-02",
    imageApiMode: "none",
    modelApiMode: "tripo",
  },
  {
    id: "openai-compatible",
    label: "OpenAI compatible",
    defaultEndpoint: "http://127.0.0.1:1234/v1",
    capabilities: ["text", "image"],
    requiresEndpoint: true,
    requiresModelId: true,
    placeholderModelId: "local-model-id",
    placeholderModelNote: "Use the exact model ID returned by the compatible endpoint's /models API.",
    sourceEvidence: {
      label: "AI SDK OpenAI Compatible Providers",
      url: "https://ai-sdk.dev/providers/openai-compatible-providers",
      lastVerifiedAt: "2026-07-03",
    },
    freshnessExpiresAt: "2026-08-02",
    imageApiMode: "openai-compatible",
  },
];

export function findByokProvider(id: string): ByokProviderMeta | undefined {
  return BYOK_PROVIDERS.find((p) => p.id === id);
}

/**
 * Per-capability model slots for a single provider connection. A provider can
 * legitimately hold several models at once — e.g. one OpenAI connection backing
 * a text chat model AND a gpt-image model — so the model id is no longer a
 * single field. `imageEdit` exists for forward-compat; today edit reuses the
 * generate model (OpenAI) or fixed catalog paths (fal), so the UI never asks
 * for it directly.
 */
export type ByokModelRole = "text" | "imageGenerate" | "imageEdit" | "video" | "model3d";

export interface ByokConnectionModels {
  text?: string;
  imageGenerate?: string;
  imageEdit?: string;
  video?: string;
  model3d?: string;
}

export const BYOK_MODEL_ROLES: readonly ByokModelRole[] = [
  "text",
  "imageGenerate",
  "imageEdit",
  "video",
  "model3d",
];

/**
 * Which model-id inputs Settings should ask the user to fill for a provider.
 * Derived from declared capabilities, minus roles whose model id is fixed
 * (fal edit paths) or a non-user operation (meshy/tripo `fixedModel3dOperation`,
 * where `requiresModelId` is false). `imageEdit` is intentionally absent: it is
 * resolved from `imageGenerate` (OpenAI) or catalog paths, never typed by hand.
 */
export function byokModelInputRoles(meta: ByokProviderMeta): ByokModelRole[] {
  const roles: ByokModelRole[] = [];
  if (meta.capabilities.includes("text")) roles.push("text");
  if (meta.capabilities.includes("image") && meta.imageApiMode !== "none") {
    roles.push("imageGenerate");
  }
  if (meta.videoApiMode && meta.videoApiMode !== "none") roles.push("video");
  if (meta.modelApiMode && meta.modelApiMode !== "none" && meta.requiresModelId) {
    roles.push("model3d");
  }
  return roles;
}

/** Drop unknown keys / non-string / blank values from a raw models object. */
export function normalizeByokModels(value: unknown): ByokConnectionModels | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const models: ByokConnectionModels = {};
  for (const role of BYOK_MODEL_ROLES) {
    const raw = record[role];
    if (typeof raw === "string" && raw.trim()) models[role] = raw.trim();
  }
  return Object.keys(models).length > 0 ? models : undefined;
}

/**
 * Resolve the per-role models for a connection from a raw source. The one place
 * the store, the route and the UI agree on, so the no-default / no-guess rule
 * can never drift between them. Accepts `unknown` so callers can pass parsed
 * JSON / disk records without pre-coercing.
 */
export function resolveByokConnectionModels(
  source: { models?: unknown },
): ByokConnectionModels | undefined {
  return normalizeByokModels(source.models);
}

export function isOpenAiGptImageModel(modelId: string | undefined): boolean {
  const normalized = modelId?.trim().toLowerCase();
  return Boolean(
    normalized &&
      (normalized.startsWith("gpt-image-") || normalized.startsWith("openai/gpt-image-")),
  );
}

export function isVideoCapableByok(id: string): boolean {
  const meta = findByokProvider(id);
  return Boolean(meta && meta.videoApiMode && meta.videoApiMode !== "none");
}

export function isModel3dCapableByok(id: string): boolean {
  const meta = findByokProvider(id);
  return Boolean(meta && meta.modelApiMode && meta.modelApiMode !== "none");
}
