"use client";

import { CreativeReadinessPanel } from "@/components/shared/creative-readiness-panel";
import type {
  CreativeCapabilityId,
  CreativeCapabilityReadiness,
} from "@/lib/client/creative-capability-readiness";
import { cn } from "@/lib/utils";

interface StudioCapabilityBannerProps {
  readiness: CreativeCapabilityReadiness;
  focusId: CreativeCapabilityId;
  className?: string;
}

export function StudioCapabilityBanner({ readiness, focusId, className }: StudioCapabilityBannerProps) {
  const focused = readiness.byId[focusId];
  if (focused.status === "ready") return null;
  const focusedReadiness: CreativeCapabilityReadiness = {
    ...readiness,
    overallStatus: focused.status,
    detail: focused.detail,
    summaryLabel: focused.shortLabel,
    primaryIssue: focused,
  };

  return (
    <CreativeReadinessPanel
      readiness={focusedReadiness}
      className={cn("mx-auto w-full max-w-5xl", className)}
    />
  );
}
