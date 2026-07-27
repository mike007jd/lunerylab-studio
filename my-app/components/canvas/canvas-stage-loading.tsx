"use client";

import { CanvasRouteState } from "@/components/canvas/canvas-route-state";
import { COPY } from "@/components/canvas/canvas-copy";
import { useI18n } from "@/lib/i18n/provider";

export function CanvasStageLoading() {
  const { locale } = useI18n();
  const copy = COPY[locale];

  return (
    <CanvasRouteState
      title={copy.openingTitle}
      description={copy.openingDescription}
    />
  );
}
