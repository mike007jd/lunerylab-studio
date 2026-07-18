"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Download } from "@/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PLATFORM_SIZES } from "@/lib/constants/platform-sizes";
import type { COPY } from "@/components/canvas/canvas-copy";

type CanvasExportCopy = (typeof COPY)[keyof typeof COPY];

interface CanvasExportPopoverProps {
  disabled: boolean;
  busy: boolean;
  isChinese: boolean;
  copy: CanvasExportCopy;
  onExportOriginal: () => Promise<boolean>;
  onExportPlatforms: (presetIds: string[]) => Promise<boolean>;
}

export function CanvasExportPopover({
  disabled,
  busy,
  isChinese,
  copy,
  onExportOriginal,
  onExportPlatforms,
}: CanvasExportPopoverProps) {
  const [open, setOpen] = useState(false);
  const [selectedPresetIds, setSelectedPresetIds] = useState<string[]>([]);
  const groupedPresets = useMemo(() => {
    const groups = new Map<string, typeof PLATFORM_SIZES[number][]>();
    for (const preset of PLATFORM_SIZES) {
      groups.set(preset.platform, [...(groups.get(preset.platform) ?? []), preset]);
    }
    return [...groups.entries()];
  }, []);

  const trigger = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={disabled || busy}
      loading={busy}
      aria-label={disabled ? copy.exportEmptyTooltip : copy.exportCanvas}
    >
      <Download className="h-3.5 w-3.5" />
      {copy.exportCanvas}
    </Button>
  );

  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="pointer-events-auto inline-flex" tabIndex={0}>
            {trigger}
          </span>
        </TooltipTrigger>
        <TooltipContent>{copy.exportEmptyTooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[min(420px,calc(100vw-24px))] space-y-4 rounded-xl border border-(--border-active) bg-(--bg-elevated) p-3 shadow-[var(--shadow-lg)]"
      >
        <div>
          <p className="text-sm font-semibold text-(--text-primary)">{copy.exportTitle}</p>
          <p className="mt-1 text-xs leading-relaxed text-(--text-muted)">{copy.exportDescription}</p>
        </div>

        <Button
          type="button"
          variant="mutedOutline"
          size="sm"
          className="w-full justify-between"
          disabled={busy}
          onClick={async () => {
            if (await onExportOriginal()) setOpen(false);
          }}
        >
          <span>{copy.exportOriginal}</span>
          <span className="text-xs font-normal text-(--text-muted)">PNG</span>
        </Button>

        <div className="space-y-2">
          <div>
            <p className="text-xs font-semibold text-(--text-secondary)">{copy.exportPlatformSizes}</p>
            <p className="mt-0.5 text-xs text-(--text-muted)">{copy.exportPlatformHint}</p>
          </div>
          <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
            {groupedPresets.map(([platform, presets]) => (
              <div key={platform} className="space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-(--text-muted)">
                  {platform}
                </p>
                <div className="grid grid-cols-1 gap-1.5">
                  {presets.map((preset) => {
                    const selected = selectedPresetIds.includes(preset.id);
                    return (
                      <Button
                        key={preset.id}
                        type="button"
                        size="sm"
                        variant={selected ? "selected" : "ghostMuted"}
                        aria-pressed={selected}
                        className="h-auto min-h-9 justify-between px-2.5 py-1.5 text-left"
                        onClick={() => setSelectedPresetIds((current) => selected
                          ? current.filter((id) => id !== preset.id)
                          : [...current, preset.id])}
                      >
                        <span className="truncate">{isChinese ? preset.labelZh : preset.label}</span>
                        <span className="ml-2 shrink-0 text-[10px] font-normal text-(--text-muted)">
                          {preset.width}×{preset.height}
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant="accent"
            size="sm"
            className="w-full"
            disabled={busy || selectedPresetIds.length === 0}
            onClick={async () => {
              if (await onExportPlatforms(selectedPresetIds)) setOpen(false);
            }}
          >
            {copy.exportSelected.replace("{count}", String(selectedPresetIds.length))}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
