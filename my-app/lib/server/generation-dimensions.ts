const ASPECT_COMPONENTS: Record<string, readonly [number, number]> = {
  "1:1": [1, 1],
  "16:9": [16, 9],
  "9:16": [9, 16],
  "4:3": [4, 3],
  "3:4": [3, 4],
  "3:2": [3, 2],
  "2:3": [2, 3],
};

/**
 * Preserve the requested ratio exactly while keeping latent dimensions aligned
 * to 8 pixels and close to the family's native square pixel budget.
 */
export function localImageDimensions(
  ratio: string | undefined,
  base: number,
): { width: number; height: number } {
  const [ratioWidth, ratioHeight] = ASPECT_COMPONENTS[ratio ?? "1:1"] ?? ASPECT_COMPONENTS["1:1"]!;
  const idealUnit = base / Math.sqrt(ratioWidth * ratioHeight);
  const alignedUnit = Math.max(8, Math.round(idealUnit / 8) * 8);
  return {
    width: ratioWidth * alignedUnit,
    height: ratioHeight * alignedUnit,
  };
}
