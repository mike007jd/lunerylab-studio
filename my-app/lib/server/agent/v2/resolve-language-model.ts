/**
 * Resolve a runtime-supply target into an AI SDK `LanguageModel` handle.
 *
 * v2 needs a single model handle to drive `generateText` with tools across all
 * steps. The runtime-supply module already decides local/byok; this
 * helper turns that decision into the actual model object the SDK consumes.
 */

import "server-only";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { ApiError } from "@/lib/server/errors";
import { resolveByokLanguageModel } from "@/lib/server/byok-llm";
import type { StudioRuntimeSupply } from "@/lib/server/runtime-supply";

interface ResolvedModel {
  model: LanguageModel;
}

export async function resolveAgentLanguageModel(
  supply: StudioRuntimeSupply,
): Promise<ResolvedModel> {
  const target = supply.text;

  if (target.backend === "local" && target.endpoint && target.modelId) {
    const provider = createOpenAICompatible({
      name: "local",
      baseURL: `${target.endpoint.replace(/\/+$/, "")}/v1`,
      apiKey: "local",
    });
    return { model: provider(target.modelId) as LanguageModel };
  }

  if (target.backend === "byok" && target.providerId) {
    return resolveByokLanguageModel({
      providerId: target.providerId,
      modelId: target.modelId,
      missingModelMessage: (meta) =>
        `${meta.label} requires a model id for the agent. Open Settings and choose a model.`,
    });
  }

  throw new ApiError({
    status: 503,
    code: "llm_backend_missing",
    message: "No local or BYOK LLM backend is configured for the agent.",
    retryable: false,
  });
}
