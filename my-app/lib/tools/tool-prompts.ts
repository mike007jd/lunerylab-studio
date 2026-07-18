import type { ToolId } from "@/lib/tools/catalog";

export interface ToolOverrides {
  isEdit: boolean;
  targetSize?: `${number}x${number}`;
}

const TOOL_PROMPT_TEMPLATES: Partial<Record<ToolId, string>> = {
  enhancer:
    "Enhance this image: improve sharpness, color vibrancy, and fine details while preserving the original composition exactly. {userPrompt}",
  upscaler:
    "Upscale this image to high resolution with realistic texture detail, sharpness, and natural clarity. Preserve all original content faithfully. {userPrompt}",
  background:
    "Keep the main subject intact and unchanged. Replace the background with: {userPrompt}",
  extender:
    "Extend this image seamlessly beyond its current boundaries. Maintain consistent lighting, perspective, and style. {userPrompt}",
  // batch: no template — user prompt passed as-is
};

const TOOL_OVERRIDES: Record<ToolId, ToolOverrides> = {
  enhancer: { isEdit: true },
  upscaler: { isEdit: true, targetSize: "2048x2048" },
  background: { isEdit: true },
  extender: { isEdit: true },
  batch: { isEdit: false },
};

const DEFAULT_OVERRIDES: ToolOverrides = { isEdit: false };

export function buildToolPrompt(toolType: ToolId | null, userPrompt: string): string {
  if (!toolType) return userPrompt;
  const template = TOOL_PROMPT_TEMPLATES[toolType];
  if (!template) return userPrompt;
  return template.replace("{userPrompt}", userPrompt).trim();
}

export function getToolOverrides(toolType: ToolId | null): ToolOverrides {
  if (!toolType) return DEFAULT_OVERRIDES;
  return TOOL_OVERRIDES[toolType] ?? DEFAULT_OVERRIDES;
}
