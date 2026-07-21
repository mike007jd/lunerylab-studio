/**
 * Public entry point for the agent runtime.
 *
 * Routes (and any future callers) import from this file so internal runtime
 * structure (executor / tools / serializer) stays an implementation detail.
 */

export { runAgent } from "@/lib/server/agent/runtime/executor";
export type { AgentRunResult } from "@/lib/server/agent/runtime/types";
