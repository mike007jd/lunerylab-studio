const DEFAULT_MAX_DIMENSION = 780;

function roundCanvasSize(value: number) {
  return Math.max(24, Math.round(value));
}

export function resolveGeneratedLayerSize(
  aspectRatio: string,
  maxDimension = DEFAULT_MAX_DIMENSION
): { width: number; height: number } {
  const match = aspectRatio.trim().match(/^(\d+):(\d+)$/);
  if (!match) {
    return { width: maxDimension, height: maxDimension };
  }

  const widthRatio = Number(match[1]);
  const heightRatio = Number(match[2]);

  if (!Number.isFinite(widthRatio) || !Number.isFinite(heightRatio) || widthRatio <= 0 || heightRatio <= 0) {
    return { width: maxDimension, height: maxDimension };
  }

  if (widthRatio === heightRatio) {
    return { width: maxDimension, height: maxDimension };
  }

  if (widthRatio > heightRatio) {
    return {
      width: maxDimension,
      height: roundCanvasSize((maxDimension * heightRatio) / widthRatio),
    };
  }

  return {
    width: roundCanvasSize((maxDimension * widthRatio) / heightRatio),
    height: maxDimension,
  };
}
