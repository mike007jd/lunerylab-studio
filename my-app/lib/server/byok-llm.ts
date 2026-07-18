/**
 * BYOK (Bring Your Own Key) LLM client.
 *
 * Reads the provider API key from the OS keychain via the desktop bridge
 * (provider-secret-read route), then constructs the appropriate AI SDK
 * provider. Never logs the key.
 *
 * Supported providers (maps provider id → AI SDK provider factory):
 *   openai, anthropic, gemini, openrouter, minimax, together, fireworks,
 *   openai-compatible
 *   replicate and fal are image-only — they throw byok_text_unsupported.
 *
 * Exported signatures mirror the local text/object helpers so callers can swap
 * by backend without type changes.
 */

import "server-only";
import { generateText, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ApiError } from "@/lib/server/errors";
import type { ByokProviderMeta } from "@/lib/byok-providers";
import {
  resolveByokProviderConfig,
  type ResolvedByokProviderConfig,
} from "@/lib/server/byok-provider-config";

// Key retrieval lives in `byok-shared.ts` — single source of truth for the
// desktop-bridge fetch. SECURITY: the key is in-memory only, never logged.

// ---------------------------------------------------------------------------
// Provider factory — maps provider id to an AI SDK language model.
// ---------------------------------------------------------------------------

function assertTextCapableProvider(meta: ByokProviderMeta) {
  if (!meta.capabilities.includes("text")) {
    throw new ApiError({
      status: 400,
      code: "byok_text_unsupported",
      message: `${meta.label} BYOK is image-only and cannot serve text generation.`,
      retryable: false,
    });
  }
}

async function buildByokModel(config: ResolvedByokProviderConfig): Promise<LanguageModel> {
  const { providerId, providerMeta: meta, apiKey, modelId, endpoint } = config;

  switch (providerId) {
    case "openai": {
      const provider = createOpenAI({
        apiKey,
        baseURL: endpoint,
      });
      return provider(modelId) as LanguageModel;
    }
    case "anthropic": {
      const provider = createAnthropic({
        apiKey,
        baseURL: endpoint,
      });
      return provider(modelId) as LanguageModel;
    }
    case "gemini": {
      const provider = createGoogleGenerativeAI({
        apiKey,
        baseURL: endpoint,
      });
      return provider(modelId) as LanguageModel;
    }
    // openrouter / minimax / together / fireworks are OpenAI-compatible and
    // carry their baseURL as `defaultEndpoint` in byok-providers.ts (the single
    // source of truth). They fall through to the `default` branch below rather
    // than re-declaring the same createOpenAICompatible call with a duplicated
    // literal URL that could silently disagree with the catalog.
    case "replicate":
    case "fal":
      throw new ApiError({
        status: 400,
        code: "byok_text_unsupported",
        message: `${meta?.label ?? providerId} BYOK is image-only and cannot serve text generation.`,
        retryable: false,
      });
    default: {
      // openai-compatible or any custom provider — use the user-supplied
      // endpoint from the connection store. Fall back to the meta default for
      // built-in providers; for fully custom ids, error if nothing configured.
      const provider = createOpenAICompatible({
        name: providerId,
        baseURL: endpoint,
        apiKey,
      });
      return provider(modelId) as LanguageModel;
    }
  }
}

export async function resolveByokLanguageModel({
  providerId,
  modelId,
  missingModelMessage,
}: {
  providerId: string;
  modelId?: string;
  missingModelMessage?: (meta: ByokProviderMeta) => string;
}): Promise<{ model: LanguageModel; modelId: string }> {
  const resolved = await resolveByokProviderConfig({
    providerId,
    validateProvider: assertTextCapableProvider,
    resolveModelId: ({ connection }) => modelId?.trim() || connection?.models?.text,
    missingEndpointMessage: () => `OpenAI-compatible provider "${providerId}" is missing an endpoint. Open Settings to configure.`,
    // No hardcoded default model: the user must specify which model to use.
    missingModelMessage: (meta) =>
      missingModelMessage?.(meta) ?? `${meta.label} requires a model id. Open Settings and choose a model.`,
  });
  return {
    model: await buildByokModel(resolved),
    modelId: resolved.modelId,
  };
}

// ---------------------------------------------------------------------------
// Text generation
// ---------------------------------------------------------------------------

export async function generateTextByok({
  systemPrompt,
  userPrompt,
  providerId,
  modelId,
  temperature,
  maxOutputTokens,
  abortSignal,
}: {
  systemPrompt: string;
  userPrompt: string;
  providerId: string;
  modelId?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Forwarded straight to the AI SDK call. Without this the user's "Cancel"
   * button can't actually interrupt an in-flight provider request, so the
   * spinner spins until the provider's own timeout fires (often 30s+).
   */
  abortSignal?: AbortSignal;
}): Promise<{ text: string; model: string }> {
  // SECURITY: apiKey is used in-process only; never passed to logs or errors.
  try {
    const resolved = await resolveByokLanguageModel({ providerId, modelId });
    const result = await generateText({
      model: resolved.model,
      system: systemPrompt,
      prompt: userPrompt,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(abortSignal ? { abortSignal } : {}),
    });
    return { text: result.text.trim(), model: resolved.modelId };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `BYOK LLM request failed (provider: ${providerId}).`,
      retryable: true,
    });
  }
}
