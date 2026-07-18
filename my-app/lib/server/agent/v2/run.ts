/**
 * Public entry point for Agent v2.
 *
 * Routes (and any future callers) import from this file so internal v2
 * structure (executor / tools / serializer) stays an implementation detail.
 */

export { runAgentV2 } from "@/lib/server/agent/v2/executor";
export type { AgentRunResult } from "@/lib/server/agent/v2/types";
