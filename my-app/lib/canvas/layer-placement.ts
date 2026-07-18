export interface LayerPlacementPlanItem {
  assetId: string;
  x: number;
  y: number;
  zIndex: number;
}

export function buildLayerPlacementPlan({
  assetIds,
  startZIndex,
  layerWidth,
  layerHeight,
  columns,
  gridGap,
  origin,
}: {
  assetIds: string[];
  startZIndex: number;
  layerWidth: number;
  layerHeight: number;
  columns: number;
  gridGap: number;
  origin: { x: number; y: number };
}): LayerPlacementPlanItem[] {
  const safeColumns = Math.max(1, columns);

  return assetIds.map((assetId, index) => {
    const column = index % safeColumns;
    const row = Math.floor(index / safeColumns);

    return {
      assetId,
      x: origin.x + column * (layerWidth + gridGap),
      y: origin.y + row * (layerHeight + gridGap),
      zIndex: startZIndex + index + 1,
    };
  });
}
