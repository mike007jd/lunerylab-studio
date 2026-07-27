"use client";

import type { ComponentProps } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageReveal } from "@/components/motion/motion-primitives";
import { StudioCapabilityBanner } from "@/components/studio/studio-capability-banner";
import { StudioComposer } from "@/components/studio/studio-composer";
import { GenerationResultsGrid } from "@/components/studio/generation-results-grid";
import type {
  CreativeCapabilityId,
  CreativeCapabilityReadiness,
} from "@/lib/client/creative-capability-readiness";
import { cn } from "@/lib/utils";

export function StudioLoadingShell() {
  return (
    <section
      aria-busy="true"
      data-slot="studio-loading-shell"
      className="relative flex w-full flex-1 flex-col justify-center gap-3 pb-20 pt-0 sm:gap-4 sm:pt-1 md:pb-14"
    >
      <div className="mx-auto w-full max-w-5xl space-y-3">
        <Skeleton className="h-40 rounded-2xl bg-(--bg-surface)" />
        <Skeleton className="mx-auto h-8 w-64 rounded-xl bg-(--bg-surface)" />
      </div>
    </section>
  );
}

export function StudioGenerationSurface({
  hydrated,
  hasResults,
  readiness,
  focusId,
  composerProps,
  resultsProps,
}: {
  hydrated: boolean;
  hasResults: boolean;
  readiness: CreativeCapabilityReadiness;
  focusId: CreativeCapabilityId;
  composerProps: ComponentProps<typeof StudioComposer>;
  resultsProps: ComponentProps<typeof GenerationResultsGrid>;
}) {
  if (!hydrated) return <StudioLoadingShell />;

  return (
    <PageReveal className="flex w-full flex-1">
      <section
        className={cn(
          "relative flex w-full flex-1 flex-col pb-20 pt-0 sm:pt-1 md:pb-14",
          hasResults ? "space-y-3 sm:space-y-4" : "justify-center gap-3 sm:gap-4",
        )}
      >
        <StudioCapabilityBanner readiness={readiness} focusId={focusId} />
        <StudioComposer {...composerProps} />
        <GenerationResultsGrid {...resultsProps} />
      </section>
    </PageReveal>
  );
}
