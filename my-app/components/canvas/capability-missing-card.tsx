"use client";

import { usePathname, useRouter } from "next/navigation";
import { Info } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useT } from "@/lib/i18n/useT";
import { cn } from "@/lib/utils";
import type { CapabilityFixCapability, CapabilityFixPanel } from "@/lib/types/api";

export interface CapabilityMissingCardProps {
  capabilityFix: {
    capability: CapabilityFixCapability;
    panel: CapabilityFixPanel;
    reason: string;
  };
  className?: string;
}

// Map each fix panel onto the shared `capabilityReadiness` i18n namespace so the
// canvas disconnected state reads the same, localized copy as the rest of the
// app instead of a private hardcoded map. Each panel gets its localized title,
// reason, settings deep-link, and action label.
const PANEL_CONFIG: Record<CapabilityFixPanel, string> = {
  provider_connections: "provider-connections",
  local_models: "local-models",
  runtime_health: "runtime-diagnostics",
};

const CAPABILITY_COPY: Record<
  CapabilityFixCapability,
  { titleKey: string; reasonKey: string; actionKey: string }
> = {
  text: {
    titleKey: "agent.textAiRequiredTitle",
    reasonKey: "agent.textAiRequiredDetail",
    actionKey: "agent.configureTextAi",
  },
  image: {
    titleKey: "agent.imageAiRequiredTitle",
    reasonKey: "agent.imageAiRequiredDetail",
    actionKey: "agent.configureImageAi",
  },
  video: {
    titleKey: "agent.videoAiRequiredTitle",
    reasonKey: "agent.videoAiRequiredDetail",
    actionKey: "agent.configureVideoAi",
  },
};

export function CapabilityMissingCard({ capabilityFix, className }: CapabilityMissingCardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useT();

  const config = CAPABILITY_COPY[capabilityFix.capability];
  const target = new URLSearchParams({
    panel: PANEL_CONFIG[capabilityFix.panel] ?? PANEL_CONFIG.provider_connections,
    capability: capabilityFix.capability,
    returnTo: pathname,
  });

  return (
    <Empty
      className={cn(
        "gap-4 border-solid border-(--warning-soft) bg-(--warning-soft) p-4 text-left md:p-4",
        className,
      )}
    >
      <EmptyHeader className="w-full max-w-none items-start text-left">
        <EmptyMedia variant="default" className="mb-0 text-(--warning)">
          <Info className="h-4 w-4 shrink-0" />
        </EmptyMedia>
        <EmptyTitle className="text-sm font-semibold text-(--warning)">
          {t(config.titleKey)}
        </EmptyTitle>
        <EmptyDescription className="text-xs leading-relaxed text-(--text-secondary)">
          {t(config.reasonKey)}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-none items-start">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => router.push(`/settings?${target.toString()}`)}
          className="border-(--warning-soft) text-(--warning) hover:bg-(--warning-soft)"
        >
          {t(config.actionKey)}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
