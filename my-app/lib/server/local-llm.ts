/**
 * Local LLM client — wraps an OpenAI-compatible local endpoint
 * (Ollama, LM Studio, llama.cpp server, MLX server, etc.) via the
 * AI SDK's createOpenAICompatible provider.
 *
 * Exported signature mirrors the BYOK text helper so callers can swap backends
 * without type changes.
 */

import "server-only";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ApiError } from "@/lib/server/errors";

// ---------------------------------------------------------------------------
// Provider factory (one per endpoint — cheap to construct)
// ---------------------------------------------------------------------------

function buildLocalProvider(endpoint: string) {
  return createOpenAICompatible({
    baseURL: `${endpoint.replace(/\/+$/, "")}/v1`,
    name: "local",
    // No API key required for localhost runtimes; send an empty bearer token
    // so the SDK doesn't fail its header-construction step.
    apiKey: "local",
  });
}

// ---------------------------------------------------------------------------
// Text generation
// ---------------------------------------------------------------------------

export async function generateTextLocal({
  systemPrompt,
  userPrompt,
  endpoint,
  modelId,
  temperature,
  maxOutputTokens,
  abortSignal,
}: {
  systemPrompt: string;
  userPrompt: string;
  endpoint: string;
  modelId: string;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}): Promise<{ text: string; model: string }> {
  try {
    const provider = buildLocalProvider(endpoint);
    const result = await generateText({
      model: provider(modelId),
      system: systemPrompt,
      prompt: userPrompt,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(abortSignal ? { abortSignal } : {}),
    });
    return { text: result.text.trim(), model: modelId };
  } catch (error) {
    throw new ApiError({
      status: 502,
      code: "provider_error",
      message: `Local LLM request failed: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    });
  }
}
