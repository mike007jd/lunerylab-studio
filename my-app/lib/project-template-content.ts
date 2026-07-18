import type { TFunction } from "@/lib/i18n/provider";

export function formatProjectTemplateContents(
  t: TFunction,
  assetCount: number,
  canvasCount: number,
): string {
  const assets = t(
    assetCount === 1
      ? "library.templateAssetCountOne"
      : "library.templateAssetCountOther",
    { count: assetCount },
  );
  const canvases = t(
    canvasCount === 1
      ? "library.templateCanvasCountOne"
      : "library.templateCanvasCountOther",
    { count: canvasCount },
  );

  return `${assets} · ${canvases}`;
}
