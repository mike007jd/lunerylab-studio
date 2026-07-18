"use client";

import Image from "next/image";
import { memo, useState } from "react";
import { ChevronDown, Sparkles } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  PRESET_CATEGORIES,
  type StylePreset,
  type StylePresetId,
  type PresetCategory,
} from "@/lib/presets/style-presets";
import { TONE_ACCENT } from "@/components/studio/studio-constants";

// ---------------------------------------------------------------------------
// PresetMiniPreview
// ---------------------------------------------------------------------------

function PresetMiniPreview({ preset }: { preset: StylePreset }) {
  const tone = TONE_ACCENT[preset.previewTone];
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  return (
    <div
      className="relative flex h-14 w-full items-end overflow-hidden rounded-t-lg px-2.5 pb-1.5 select-none"
      style={{ backgroundColor: tone.bg }} // keep-dynamic: per-preset tone bg; 6 distinct values from TONE_ACCENT
    >
      {!imageLoadFailed ? (
        <Image
          src={preset.coverImage}
          alt={`${preset.name} preview`}
          fill
          unoptimized
          sizes="(max-width: 768px) 45vw, 240px"
          className="object-cover opacity-85"
          onError={() => setImageLoadFailed(true)}
        />
      ) : null}
      <div className="absolute inset-0 bg-linear-to-t from-(--bg-base)/45 via-(--bg-base)/10 to-transparent" />
      <div
        className="absolute inset-0 opacity-40"
        style={{
          // keep-dynamic: per-preset dot color interpolated into gradient; 6 values
          backgroundImage: `radial-gradient(${tone.dot} 0.5px, transparent 0.5px)`,
          backgroundSize: "10px 10px",
        }}
      />
      <span
        className="relative z-1 text-[10px] font-semibold"
        style={{ color: tone.label }} // keep-dynamic: per-preset label color; runtime value
      >
        {preset.category.replace("-", " ")}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PresetPicker
// ---------------------------------------------------------------------------

interface PresetPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeCategory: PresetCategory;
  onCategoryChange: (cat: PresetCategory) => void;
  filteredPresets: StylePreset[];
  selectedPresetId: StylePresetId | "";
  selectedPreset: StylePreset | null;
  onSelectPreset: (preset: StylePreset) => void;
  onClearSelection: () => void;
  isZh: boolean;
  stylePresetLabel: string;
  clearSelectionLabel: string;
}

export const PresetPicker = memo(function PresetPicker({
  open,
  onOpenChange,
  activeCategory,
  onCategoryChange,
  filteredPresets,
  selectedPresetId,
  selectedPreset,
  onSelectPreset,
  onClearSelection,
  isZh,
  stylePresetLabel,
  clearSelectionLabel,
}: PresetPickerProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={selectedPreset ? "accentSoft" : "mutedOutline"}
          size="xs"
          className={cn(
            // Width-bounded trigger: a long preset name truncates instead of
            // resizing the toolbar and pushing the adjacent Options control.
            "h-8 w-40 justify-between gap-1.5 rounded-md px-2.5",
            selectedPreset
              ? "border-(--accent-primary)/25 bg-(--accent-primary)/8 text-(--accent-primary)"
              : "border-(--border-subtle) text-(--text-muted) hover:border-(--border-active) hover:text-(--text-secondary)"
          )}
        >
          <Sparkles className="h-3 w-3" />
          <span className="min-w-0 flex-1 truncate text-left">
            {selectedPreset
              ? (isZh ? selectedPreset.nameZh : selectedPreset.name)
              : stylePresetLabel}
          </span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        className="w-[min(468px,calc(100vw-24px))] max-w-[calc(100vw-24px)] rounded-xl border border-(--border-active) bg-(--bg-elevated) p-0 shadow-[var(--shadow-lg),var(--shadow-glow)]"
      >
        {/* Category tabs */}
        <ToggleGroup
          type="single"
          value={activeCategory}
          onValueChange={(value) => {
            if (value) {
              onCategoryChange(value as PresetCategory);
            }
          }}
          size="sm"
          className="flex-wrap gap-1 border-b border-(--border-subtle) px-3 py-2"
          spacing={1}
        >
          {PRESET_CATEGORIES.map((cat) => (
            <ToggleGroupItem
              key={cat.id}
              value={cat.id}
              className={cn(
                "h-8 rounded-md px-2.5 text-xs",
                activeCategory === cat.id
                  ? "bg-(--accent-primary)/12 text-(--accent-primary)"
                  : "text-(--text-muted) hover:text-(--text-secondary) hover:bg-(--bg-glass)"
              )}
            >
              {isZh ? cat.labelZh : cat.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {/* Preset cards */}
        <div className="grid max-h-[min(56vh,420px)] grid-cols-1 gap-2 overflow-y-auto p-3 sm:grid-cols-2">
          {filteredPresets.map((preset) => {
            const isActive = selectedPresetId === preset.id;
            return (
              <Button
                key={preset.id}
                type="button"
                variant="ghost"
                onClick={() => onSelectPreset(preset)}
                className={cn(
                  "group h-auto w-full flex-col items-start justify-start overflow-hidden whitespace-normal rounded-lg border p-0 text-left transition-[color,background-color,border-color,box-shadow]",
                  isActive
                    ? "border-(--accent-primary)/40 bg-(--bg-surface) ring-1 ring-(--accent-primary)/20"
                    : "border-(--border-subtle) bg-(--bg-surface) hover:border-(--border-active)"
                )}
              >
                <PresetMiniPreview preset={preset} />
                <div className="px-2.5 py-2">
                  <p className={cn(
                    "text-xs font-semibold leading-snug",
                    isActive ? "text-(--accent-primary)" : "text-foreground"
                  )}>
                    {isZh ? preset.nameZh : preset.name}
                  </p>
                  <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground">
                    {isZh ? preset.descriptionZh : preset.description}
                  </p>
                </div>
              </Button>
            );
          })}
        </div>
        {/* Clear selection */}
        {selectedPreset ? (
          <div className="border-t border-(--border-subtle) px-3 py-2">
            <Button
              type="button"
              variant="ghostMuted"
              size="xs"
              onClick={onClearSelection}
              className="px-0"
            >
              {clearSelectionLabel}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
});
