"use client";

import { useMemo, useState } from "react";
import type { ImageModelEntry } from "@/lib/image-models";
import type { SdProgress } from "@/lib/types/sd-progress";
import type { TFunction } from "@/lib/i18n/provider";
import type { UseStudioGenerationHistoryResult } from "@/components/studio/use-studio-generation-history";
import type { GenerationActivityRegistry } from "@/components/studio/controllers/generation-activity-registry";
import { createImageGenerationController } from "@/components/studio/controllers/image-generation-controller";

export function useImageGenerationController({
  registry,
  history,
  imageModels,
  t,
}: {
  registry: GenerationActivityRegistry;
  history: UseStudioGenerationHistoryResult;
  imageModels: ImageModelEntry[];
  t: TFunction;
}) {
  const [progressByEntry, setProgressByEntry] = useState<
    Record<string, SdProgress | undefined>
  >({});
  const controller = useMemo(
    () =>
      createImageGenerationController({
        registry,
        history,
        imageModels,
        t,
        setProgress: setProgressByEntry,
      }),
    [history, imageModels, registry, t],
  );
  return { ...controller, progressByEntry };
}
