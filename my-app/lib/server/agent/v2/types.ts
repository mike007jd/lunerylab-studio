/**
 * Agent v2 types — plan-DAG + tool-registry + iterative executor.
 *
 * v2 replaces the v1 4-action enum (answer/image/edit/video) with a dynamic
 * tool registry executed in a multi-step loop by the AI SDK. Each step is a
 * tool call; tool results flow back to the LLM, which decides the next step
 * or finishes.
 */

import type { Locale } from "@/lib/i18n/locale";
import type {
  AgentBackendKind,
  CapabilityFixCapability,
  CapabilityFixPanel,
} from "@/lib/types/api";

export type AgentToolCategory =
  | "observe"
  | "generation"
  | "canvas"
  | "brand"
  | "control";

export type AgentStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentStep {
  /** Stable id (uuid). Matches the AI SDK tool-call id when available. */
  id: string;
  /** Sequential index inside this run. */
  index: number;
  /** Tool name the LLM chose. */
  toolName: string;
  /** Category for UI grouping. */
  category: AgentToolCategory;
  /** Free-form one-liner the executor records (e.g. "Generated 4 images"). */
  summary: string;
  /** JSON-serializable artifact ids produced by this step. */
  artifacts: AgentStepArtifacts;
  /** Tool input as the LLM saw it (kept for replay/debug — sanitized of refs). */
  input?: Record<string, unknown>;
  /** Tool output as fed back to the LLM (succinct). */
  output?: Record<string, unknown>;
  status: AgentStepStatus;
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface AgentStepArtifacts {
  /** Asset ids generated this step (image / video / 3D file). */
  generatedAssetIds?: string[];
  /** Canvas layer ids created this step. */
  createdLayerIds?: string[];
  /** Canvas layer ids modified this step. */
  modifiedLayerIds?: string[];
  /** Background video job id (async). */
  videoJobId?: string;
}

export interface AgentRunResult {
  runId: string;
  /** Final natural-language reply for the user (extracted from LLM final message). */
  assistantMessage: string;
  steps: AgentStep[];
  /** Union of all artifacts produced across steps — for quick UI access. */
  artifacts: AgentStepArtifacts;
  /** Backend used for this run (display + structured). */
  backendUsed: { llm: string; image: string };
  generationBackend: AgentBackendKind;
  imageBackend: AgentBackendKind;
  /** If a step needed a backend that is missing, this points the user to fix. */
  capabilityFix?: {
    capability: CapabilityFixCapability;
    panel: CapabilityFixPanel;
    reason: string;
  };
  /** Sanitized user-visible error for deterministic action/provider failures. */
  error?: { code?: string; message: string };
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** True if the executor stopped because it hit the step budget. */
  stoppedByBudget: boolean;
  /** Snapshot captured before this task; present when whole-task undo is available. */
  beforeSnapshotId?: string;
}

export interface AgentRunInput {
  taskId?: string;
  userId: string;
  sessionId: string;
  message: string;
  selectedLayerId: string | null;
  uiContext: {
    selectedTextModelId: string;
    selectedModelId: string;
    selectedAspectRatio: string;
    selectedCount: number;
    generationMode: "image" | "video";
  };
  locale?: Locale;
  region?: {
    positionHint: string;
    bbox: { x: number; y: number; width: number; height: number };
  } | null;
  /** Optional uploaded black/white mask asset for inpaint operations. */
  maskAssetId?: string | null;
  /**
   * Deterministic business action requested by a first-party UI control.
   * These bypass model planning while reusing the same tool implementations,
   * asset-write transactions, canvas mutations, snapshots, and progress stream.
   */
  action?:
    | { type: "inpaint_layer"; layerId: string; prompt: string }
    | { type: "remove_background"; layerId: string };
  /** Cancels model planning between steps when the client stops the run. */
  abortSignal?: AbortSignal;
  /** Max tool steps per run. Default 12. */
  maxSteps?: number;
  /**
   * Optional callback invoked once per agent step as soon as the tool
   * resolves. Used by the streaming route (`?stream=1`) to push SSE events
   * to the UI without waiting for the full run to finish. Pure observer —
   * mutating fields here will not affect the run.
   */
  onStep?: (step: AgentStep) => void;
  /** Real model text deltas only. Never synthesized progress or hidden reasoning. */
  onTextDelta?: (delta: string) => void;
}
