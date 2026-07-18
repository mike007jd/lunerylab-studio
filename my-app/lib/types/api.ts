import type { ToolId } from "@/lib/tools/catalog";
import type { CanvasDrawingState } from "@/lib/canvas/drawing-state";

export type JobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
export type ToolType = ToolId;
export const CANVAS_SESSION_STATUSES = ["EDITING", "GENERATING", "DONE", "FAILED"] as const;
export type CanvasSessionStatus = (typeof CANVAS_SESSION_STATUSES)[number];

export interface ApiErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export type AssetModality = "IMAGE" | "VIDEO" | "MODEL_3D";
export type ContentOrigin = "USER" | "TEMPLATE";

export interface AssetDTO {
  id: string;
  jobId: string;
  projectId: string | null;
  kind: "REFERENCE" | "GENERATED";
  origin: ContentOrigin;
  modality: AssetModality;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  format: string | null;
  durationSeconds: number | null;
  tags: string[];
  isFavorite: boolean;
  note: string | null;
  summary: string | null;
  agentTaskId: string | null;
  parentAssetId: string | null;
  deletedAt: string | null;
  createdAt: string;
  url: string;
  generationSeed?: number | null;
  generationSteps?: number | null;
  generationCfg?: number | null;
  negativePrompt?: string | null;
  generationModel?: string | null;
}

export interface ProjectDTO {
  id: string;
  name: string;
  category: "STUDIO";
  createdAt: string;
  updatedAt: string;
  jobCount: number;
  assetCount: number;
  canvasSessionCount: number;
  latestCanvasSession: {
    id: string;
    title: string;
    status: CanvasSessionStatus;
    updatedAt: string;
  } | null;
}

export interface GenerationRequest {
  prompt: string;
  count?: number;
  aspectRatio?: string;
  model?: string;
  projectId?: string;
  toolType?: ToolType;
}

export interface GenerationResponse {
  job: {
    id: string;
    status: JobStatus;
    requestedCount: number;
    successCount: number;
    errorCode?: string;
    errorMessage?: string;
    projectId: string | null;
  };
  assets: AssetDTO[];
  warnings: string[];
}

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
  provider: "local" | "byok" | "rule-fallback";
  model: string;
  optimizedPrompt: string;
}

export interface CanvasLayerDTO {
  id: string;
  sessionId: string;
  assetId: string;
  assetUrl?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  locked: boolean;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasSessionDTO {
  id: string;
  projectId?: string;
  selectedAssetId?: string | null;
  title: string;
  status: CanvasSessionStatus;
  zoom: number;
  panX: number;
  panY: number;
  drawingState?: CanvasDrawingState;
  layers?: CanvasLayerDTO[];
  createdAt: string;
  updatedAt: string;
}

/** Canonical union of which generation backend is active for a given capability. */
export type AgentBackendKind = "local" | "byok" | "none";
export type CapabilityFixCapability = "text" | "image" | "video";
/** Canonical union of which settings panel to open when a capability is missing. */
export type CapabilityFixPanel = "provider_connections" | "local_models" | "runtime_health";
