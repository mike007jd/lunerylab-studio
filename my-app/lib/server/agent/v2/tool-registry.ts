/**
 * v2 tool registry.
 *
 * Holds the runtime context every tool needs (user, session, snapshot, supply,
 * step recorder) and exposes a single `buildAgentToolset(ctx)` to hand AI SDK.
 *
 * Each tool file in `./tools/` exports a `build<Name>Tool(ctx)` factory; this
 * file is just the assembly point so the executor stays small.
 */

import type { Tool } from "ai";
import type { Locale } from "@/lib/i18n/locale";
import type { StudioRuntimeSupply } from "@/lib/server/runtime-supply";
import type { AgentStep, AgentStepArtifacts } from "@/lib/server/agent/v2/types";
import type { CanvasSnapshot } from "@/lib/server/agent/v2/canvas-serializer";
import { buildObserveCanvasTool } from "@/lib/server/agent/v2/tools/observe-canvas";
import { buildGenerateImageTool } from "@/lib/server/agent/v2/tools/generate-image";
import { buildEditLayerTool } from "@/lib/server/agent/v2/tools/edit-layer";
import { buildGenerateVideoTool } from "@/lib/server/agent/v2/tools/generate-video";
import {
  buildMoveLayerTool,
  buildReorderLayerTool,
  buildSetLayerVisibilityTool,
} from "@/lib/server/agent/v2/tools/canvas-ops";
import { buildExportPlatformsTool } from "@/lib/server/agent/v2/tools/export-platforms";
import { buildListReferenceSetsTool } from "@/lib/server/agent/v2/tools/reference-set-ops";
import { buildGenerate3dTool } from "@/lib/server/agent/v2/tools/generate-3d";
import {
  buildInpaintLayerTool,
  buildRemoveBackgroundTool,
} from "@/lib/server/agent/v2/tools/image-edit";
import { buildPublicWebResearchTool } from "@/lib/server/agent/v2/tools/public-web-research";

export interface AgentToolContext {
  taskId?: string;
  userId: string;
  sessionId: string;
  projectId: string | null;
  locale: Locale;
  region: {
    positionHint: string;
    bbox: { x: number; y: number; width: number; height: number };
  } | null;
  /** Short-lived black/white canvas mask token used by inpaint_layer when present. */
  maskAssetId: string | null;
  /** Shared cancellation signal for stream Stop / client disconnect. */
  abortSignal?: AbortSignal;
  uiContext: {
    selectedModelId: string;
    selectedAspectRatio: string;
    selectedCount: number;
    generationMode: "image" | "video";
  };
  supply: StudioRuntimeSupply;
  /** Latest canvas snapshot. The executor refreshes this between steps. */
  snapshot: CanvasSnapshot;
  /** Serialized snapshot refresh. Tool calls can run concurrently in one model step. */
  refreshSnapshot: () => Promise<void>;
  /** Step recorder — every tool appends one record per call. */
  recordStep: (step: AgentStep) => void;
  /** Artifact collector — tools that produce assets append here. */
  collectArtifacts: (artifacts: AgentStepArtifacts) => void;
  /** Mutable counter for step indices, owned by the executor. */
  nextStepIndex: () => number;
}

export function buildAgentToolset(ctx: AgentToolContext): Record<string, Tool> {
  return {
    observe_canvas: buildObserveCanvasTool(ctx),
    generate_image: buildGenerateImageTool(ctx),
    edit_layer: buildEditLayerTool(ctx),
    generate_video: buildGenerateVideoTool(ctx),
    move_layer: buildMoveLayerTool(ctx),
    reorder_layer: buildReorderLayerTool(ctx),
    set_layer_visibility: buildSetLayerVisibilityTool(ctx),
    export_layer_for_platforms: buildExportPlatformsTool(ctx),
    list_reference_sets: buildListReferenceSetsTool(ctx),
    inpaint_layer: buildInpaintLayerTool(ctx),
    remove_background: buildRemoveBackgroundTool(ctx),
    generate_3d: buildGenerate3dTool(ctx),
    search_public_web: buildPublicWebResearchTool(ctx),
  };
}
