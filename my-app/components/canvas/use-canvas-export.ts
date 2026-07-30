"use client";

/**
 * Canvas export owner: composition capture, the export request, and the busy
 * flag that keeps a second export from starting mid-flight.
 */

import { useCallback, useState, type RefObject } from "react";
import { toast } from "sonner";
import type { CanvasCopy } from "@/components/canvas/canvas-copy";
import type { KonvaStageHandle } from "@/components/canvas/konva-stage";
import { fetchJson, toErrorMessage } from "@/lib/client/fetch-json";

interface CanvasExportResponse {
  exports: Array<{
    id: string;
    url: string;
    presetId: string;
    downloadName: string;
  }>;
}

function downloadCanvasExports(exports: CanvasExportResponse["exports"]): void {
  for (const item of exports) {
    const anchor = document.createElement("a");
    anchor.href = item.url;
    anchor.download = item.downloadName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
}

export interface CanvasExport {
  exportBusy: boolean;
  exportOriginal: () => Promise<boolean>;
  exportPlatforms: (presetIds: string[]) => Promise<boolean>;
}

export function useCanvasExport({
  sessionId,
  stageRef,
  copy,
}: {
  sessionId: string;
  stageRef: RefObject<KonvaStageHandle | null>;
  copy: CanvasCopy;
}): CanvasExport {
  const [exportBusy, setExportBusy] = useState(false);

  const exportCanvas = useCallback(async (
    mode: "original" | "platforms",
    presetIds: string[] = [],
  ): Promise<boolean> => {
    if (exportBusy) return false;
    const composition = await stageRef.current?.exportComposition();
    if (!composition?.ok) {
      toast.error(composition?.reason === "empty" ? copy.exportEmptyTooltip : copy.exportUnavailable);
      return false;
    }
    setExportBusy(true);
    try {
      const formData = new FormData();
      formData.append("source", composition.blob, `canvas-${sessionId}.png`);
      formData.append("mode", mode);
      presetIds.forEach((presetId) => formData.append("presetIds", presetId));
      const response = await fetchJson<CanvasExportResponse>(
        `/api/canvas/sessions/${encodeURIComponent(sessionId)}/export`,
        { method: "POST", body: formData },
      );
      downloadCanvasExports(response.exports);
      toast.success(copy.exportComplete);
      return true;
    } catch (exportError) {
      toast.error(toErrorMessage(exportError, copy.exportFailed));
      return false;
    } finally {
      setExportBusy(false);
    }
  }, [copy, exportBusy, sessionId, stageRef]);

  const exportOriginal = useCallback(
    () => exportCanvas("original"),
    [exportCanvas],
  );
  const exportPlatforms = useCallback(
    (presetIds: string[]) => exportCanvas("platforms", presetIds),
    [exportCanvas],
  );

  return { exportBusy, exportOriginal, exportPlatforms };
}
