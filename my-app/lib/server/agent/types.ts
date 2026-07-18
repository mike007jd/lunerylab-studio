/**
 * Shared request-shape types for the canvas agent route. The agent runtime
 * itself (executor, tools, serializer) carries its own types under `v2/`.
 */

export interface AgentUiContext {
  selectedTextModelId: string;
  selectedModelId: string;
  selectedAspectRatio: string;
  selectedCount: number;
  generationMode: "image" | "video";
}

export interface AgentMarkedRegion {
  positionHint: string;
  bbox: { x: number; y: number; width: number; height: number };
}
