export const ASPECT_RATIOS = [
  { value: "auto", label: "Auto" },
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
] as const;

export type AspectRatioValue = (typeof ASPECT_RATIOS)[number]["value"];

export const COUNT_OPTIONS = [1, 2, 4] as const;

export type CountValue = (typeof COUNT_OPTIONS)[number];

export interface GenerationOptions {
  aspectRatio: AspectRatioValue;
  count: CountValue;
}
