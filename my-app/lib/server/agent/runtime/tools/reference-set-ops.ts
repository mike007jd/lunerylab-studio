/**
 * Reference Set agent tool.
 *
 * Read-only surface: the agent can list the named Reference Sets pinned to the
 * current project so it can pick the one the user most likely means. Mutation
 * stays a Settings/Project UI affordance.
 */

import { tool, type Tool } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  listReferenceSets,
  type ReferenceSetSnapshot,
} from "@/lib/server/reference-set";
import type { AgentToolContext } from "@/lib/server/agent/runtime/tool-registry";

function describeSet(set: ReferenceSetSnapshot): {
  id: string;
  name: string;
  description: string | null;
  assetCount: number;
  isDefault: boolean;
} {
  return {
    id: set.id,
    name: set.name,
    description: set.description,
    assetCount: set.assetIds.length,
    isDefault: set.isDefault,
  };
}

export function buildListReferenceSetsTool(ctx: AgentToolContext): Tool {
  return tool({
    description:
      "List all named reference sets pinned to the current project (e.g. mood boards, character sheets, scene references). Use to discover which set the user most likely means.",
    inputSchema: z.object({}),
    async execute() {
      const startedAt = new Date().toISOString();
      const stepId = randomUUID();
      if (!ctx.projectId) {
        ctx.recordStep({
          id: stepId,
          index: ctx.nextStepIndex(),
          toolName: "list_reference_sets",
          category: "brand",
          summary: "No project reference sets are attached to this canvas.",
          artifacts: {},
          input: {},
          output: { count: 0 },
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
        });
        return { ok: true, sets: [] };
      }
      const sets = await listReferenceSets(ctx.projectId, ctx.userId).catch(() => []);
      ctx.recordStep({
        id: stepId,
        index: ctx.nextStepIndex(),
        toolName: "list_reference_sets",
        category: "brand",
        summary: `Found ${sets.length} reference set${sets.length === 1 ? "" : "s"}.`,
        artifacts: {},
        input: {},
        output: { count: sets.length },
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return { ok: true, sets: sets.map(describeSet) };
    },
  });
}
