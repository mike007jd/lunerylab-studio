// Client-safe shared types for the ComfyUI attach feature. Server modules own
// the validation/persistence logic; the workspace UI imports only from here.

export interface ComfySshStart {
  /** SSH host alias from ~/.ssh.config, e.g. "gmk". Validated by the bridge. */
  hostAlias: string;
  /** Remote command that starts ComfyUI on that host, e.g. "~/ai/comfy start". */
  command: string;
}

export interface ComfySystemStats {
  comfyUiVersion?: string;
  frontendVersion?: string;
  pythonVersion?: string;
  pytorchVersion?: string;
  os?: string;
  ramTotalBytes?: number;
  ramFreeBytes?: number;
  deviceName?: string;
  deviceType?: string;
  vramTotalBytes?: number;
  vramFreeBytes?: number;
}

export interface ComfySyncSnapshot {
  at: string;
  system: ComfySystemStats;
  /** Model folder → file names visible to that ComfyUI instance. */
  models: Partial<Record<string, string[]>>;
}

export interface ComfyConnection {
  id: string;
  name: string;
  endpoint: string;
  sshStart?: ComfySshStart;
  createdAt: string;
  updatedAt: string;
  lastSync?: ComfySyncSnapshot;
}

export interface ComfyConnectionState {
  connections: ComfyConnection[];
  activeConnectionId?: string;
}

export type ComfyConnectionStatus = "unknown" | "checking" | "online" | "offline";

export interface ComfyTestResponse {
  ok: boolean;
  endpoint?: string;
  systemStats?: ComfySystemStats;
  error?: string;
  code?: string;
}

export type ComfyActivityJobStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * One Studio-submitted ComfyUI job, as served by GET /api/comfy-activity.
 * Memory-only live feed — the workspace uses it to load the running graph
 * into the embedded canvas and to attribute canvas activity to Studio.
 */
export interface ComfyActivityJob {
  /** ComfyUI prompt_id returned by POST /prompt. */
  id: string;
  /** Configured endpoint the job was submitted to (as saved on the connection). */
  endpoint: string;
  status: ComfyActivityJobStatus;
  /** API-format workflow (the POST /prompt body) — the canvas loads this verbatim. */
  workflow: unknown;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
}
