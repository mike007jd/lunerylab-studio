export type ToolCategory = "All" | "Enhancement" | "Background" | "Batch";

export interface ToolPreset {
  id: string;
  category: Exclude<ToolCategory, "All">;
  requiresReference: boolean;
  requiresEdit: boolean;
}

export const TOOL_PRESETS = [
  {
    id: "enhancer",
    category: "Enhancement",
    requiresReference: true,
    requiresEdit: true,
  },
  {
    id: "background",
    category: "Background",
    requiresReference: true,
    requiresEdit: true,
  },
  {
    id: "batch",
    category: "Batch",
    requiresReference: true,
    requiresEdit: false,
  },
  {
    id: "upscaler",
    category: "Enhancement",
    requiresReference: true,
    requiresEdit: true,
  },
  {
    id: "extender",
    category: "Background",
    requiresReference: true,
    requiresEdit: true,
  },
] as const satisfies readonly ToolPreset[];

export type ToolId = (typeof TOOL_PRESETS)[number]["id"];

export function findToolById(id: string | null | undefined) {
  if (!id) return null;
  return TOOL_PRESETS.find((tool) => tool.id === id) ?? null;
}
