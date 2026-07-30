import type {
  AssetDTO as GenerationAssetDTO,
  GenerationResponse as ParsedGenerationResponse,
} from "@/lib/schemas/generation";

export type JobStatus = ParsedGenerationResponse["job"]["status"];
export const CANVAS_SESSION_STATUSES = ["EDITING", "GENERATING", "DONE", "FAILED"] as const;
export type CanvasSessionStatus = (typeof CANVAS_SESSION_STATUSES)[number];

export interface ApiErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export type AssetModality = GenerationAssetDTO["modality"];
export type ContentOrigin = GenerationAssetDTO["origin"];

export type AssetDTO = GenerationAssetDTO;

export type GenerationResponse = ParsedGenerationResponse;

export interface PromptOptimizeRequest {
  prompt: string;
  mode: "general" | "photo" | "illustration" | "concept" | "background";
  referenceCount?: number;
  templateId?: string;
  templateTitle?: string;
  templatePrompt?: string;
  locale?: string;
}

export interface PromptOptimizeResponse {
  provider: "local" | "byok";
  model: string;
  optimizedPrompt: string;
}

/** Canonical union of which generation backend is active for a given capability. */
export type AgentBackendKind = "local" | "byok" | "none";
export type CapabilityFixCapability = "text" | "image" | "video";
/** Canonical union of which settings panel to open when a capability is missing. */
export type CapabilityFixPanel = "provider_connections" | "local_models" | "runtime_health";
