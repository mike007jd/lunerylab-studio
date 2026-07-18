"use client";

import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/useT";
import type { AgentBackendKind } from "@/lib/types/api";

interface AgentCapabilityBadgeProps {
  backendUsed: { llm: string; image: string };
  generationBackend?: AgentBackendKind;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kindLabel(kind: AgentBackendKind | undefined, t: ReturnType<typeof useT>): string {
  if (kind === "local") return t("agent.sourceLocalAi");
  if (kind === "byok") return t("agent.sourceCloudAi");
  return t("agent.sourceAi");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Unobtrusive badge shown next to a completed turn's result event in the
 * canvas agent timeline. Renders nothing when backendUsed is absent.
 */
export function AgentCapabilityBadge({ backendUsed, generationBackend }: AgentCapabilityBadgeProps) {
  const t = useT();
  const label = kindLabel(generationBackend, t);
  const details =
    backendUsed.llm === backendUsed.image
      ? backendUsed.llm
      : `${backendUsed.llm} / ${backendUsed.image}`;

  return (
    <Badge
      variant="secondary"
      className="mt-1.5 text-[10px] text-(--text-muted)"
      title={details}
      aria-label={`${label}: ${details}`}
    >
      {label}
    </Badge>
  );
}
