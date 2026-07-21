"use client";

import Image from "next/image";
import { memo } from "react";
import { ArrowLeft, ArrowRight, Plus, X } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { StudioReferencePreview } from "@/components/studio/hooks/use-studio-reference-files";
import { COMPOSER_DECK_FOOTPRINT_WIDTH_CLASS, MAX_REFERENCE_FILES } from "@/components/studio/studio-constants";

interface ComposerDeckProps {
  filePreviews: StudioReferencePreview[];
  draggingPreviewKey: string | null;
  dragOverPreviewKey: string | null;
  onOpenFilePicker: () => void;
  onRemoveFile: (key: string) => void;
  onMoveFile: (key: string, direction: -1 | 1) => void;
  onDragStart: (key: string) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent<HTMLElement>, key: string) => void;
  onDragLeave: (key: string) => void;
  onDrop: (key: string) => void;
  removeLabel: string;
  addLabel: string;
  moveBeforeLabel: string;
  moveAfterLabel: string;
  disabled?: boolean;
}

export const ComposerDeck = memo(function ComposerDeck({
  filePreviews,
  draggingPreviewKey,
  dragOverPreviewKey,
  onOpenFilePicker,
  onRemoveFile,
  onMoveFile,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  removeLabel,
  addLabel,
  moveBeforeLabel,
  moveAfterLabel,
  disabled = false,
}: ComposerDeckProps) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute left-4 top-4 z-20 overflow-visible",
        filePreviews.length === 0 ? "h-24 w-32" : cn("h-27 w-38", COMPOSER_DECK_FOOTPRINT_WIDTH_CLASS)
      )}
    >
      <div
        className={cn(
          filePreviews.length === 0
            ? "pointer-events-auto relative h-24 w-32 overflow-visible"
            : "pointer-events-auto group/deck relative h-27 w-full overflow-visible"
        )}
      >
        {filePreviews.length === 0 ? (
          <Button
            type="button"
            disabled={disabled}
            onClick={() => onOpenFilePicker()}
            aria-label={addLabel}
            variant="ghost"
            size="icon"
            className="flex h-24 w-32 flex-col items-center justify-center gap-1.5 rounded-(--radius-card) border border-dashed border-(--border-subtle) bg-(--bg-elevated) px-2 text-(--text-secondary) shadow-(--shadow-xs) transition-colors duration-(--motion-control) hover:border-(--border-active) hover:bg-(--bg-surface) hover:text-(--text-primary) disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Plus className="h-6 w-6" />
            <span className="line-clamp-2 text-center text-xs font-medium leading-tight">
              {addLabel}
            </span>
          </Button>
        ) : (
          <>
            {/* Stacked preview (default state) */}
            <div className="pointer-events-none absolute inset-0 z-20 hidden items-center opacity-100 transition-opacity duration-(--motion-control) group-hover/deck:opacity-0 group-focus-within/deck:opacity-0 md:flex">
              <div className="relative h-24 w-38">
                {(filePreviews.length === 1 ? filePreviews : filePreviews.slice(0, 4)).map(
                  (preview, index) => {
                    const rotation = filePreviews.length === 1 ? -6 : -11 + index * 5;
                    const offset = filePreviews.length === 1 ? 14 : 10 + index * 14;
                    return (
                      <div
                        key={`stack-${preview.key}`}
                        className="absolute top-0.5 h-22.5 w-16.5 overflow-hidden rounded-(--radius-card) border-2 border-(--border-active) shadow-(--shadow-md)"
                        style={{ left: offset, transform: `rotate(${rotation}deg)`, zIndex: index + 1 }} // keep-dynamic: per-card fan-deck layout offset/rotation + stacking from index
                      >
                        <Image
                          src={preview.url}
                          alt={preview.file.name}
                          fill
                          unoptimized
                          className="object-cover"
                        />
                      </div>
                    );
                  }
                )}
                {filePreviews.length < MAX_REFERENCE_FILES ? (
                  <Button
                    type="button"
                    disabled={disabled}
                    onClick={() => onOpenFilePicker()}
                    variant="ghost"
                    size="icon"
                    className="pointer-events-auto absolute -bottom-0.5 right-0.5 z-20 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-(--border-subtle) bg-(--bg-elevated) text-foreground shadow-(--shadow-lg) transition-colors hover:bg-(--bg-surface) disabled:cursor-not-allowed disabled:opacity-45"
                    aria-label={addLabel}
                  >
                    <Plus className="h-5 w-5" />
                  </Button>
                ) : null}
              </div>
            </div>

            {/* Expanded strip (on hover) */}
            <div
              className={cn(
                "pointer-events-auto absolute inset-0 z-30 w-[min(calc(100vw-3rem),520px)] opacity-100 transition-[opacity,width] duration-(--motion-overlay)",
                "md:pointer-events-none md:w-full md:opacity-0 md:group-hover/deck:pointer-events-auto md:group-hover/deck:w-[min(74vw,520px)] md:group-hover/deck:opacity-100 md:group-focus-within/deck:pointer-events-auto md:group-focus-within/deck:w-[min(74vw,520px)] md:group-focus-within/deck:opacity-100"
              )}
            >
              <div className="pointer-events-auto flex h-full items-center overflow-x-auto overflow-y-hidden px-1 py-1.5">
                {filePreviews.map((preview, index) => (
                  <div
                    key={preview.key}
                    draggable={!disabled}
                    onDragStart={() => onDragStart(preview.key)}
                    onDragEnd={onDragEnd}
                    onDragOver={(event) => onDragOver(event, preview.key)}
                    onDragLeave={() => onDragLeave(preview.key)}
                    onDrop={(event) => {
                      event.preventDefault();
                      onDrop(preview.key);
                    }}
                    className={cn(
                      "group/card pointer-events-auto relative h-23 w-17 shrink-0 cursor-grab overflow-hidden rounded-(--radius-card) border-2 border-(--border-active) shadow-(--shadow-md) transition active:cursor-grabbing",
                      index > 0 ? "ml-1 md:-ml-1.5" : "",
                      draggingPreviewKey === preview.key ? "opacity-50" : "",
                      dragOverPreviewKey === preview.key ? "ring-2 ring-primary/70 ring-offset-0" : ""
                    )}
                    style={{ transform: `rotate(${index % 2 === 0 ? -5 : 4}deg)`, zIndex: index + 1 }} // keep-dynamic: runtime deck card transform from index
                  >
                    <Image
                      src={preview.url}
                      alt={preview.file.name}
                      fill
                      unoptimized
                      className="object-cover"
                    />
                    <Button
                      type="button"
                      disabled={disabled}
                      onClick={() => onRemoveFile(preview.key)}
                      aria-label={`${removeLabel}: ${preview.file.name}`}
                      variant="ghost"
                      size="icon-xs"
                      className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-(--bg-elevated) text-(--text-primary) opacity-100 backdrop-blur-sm transition-[opacity,background-color] duration-(--motion-control) hover:bg-(--bg-surface) md:opacity-0 md:group-hover/card:opacity-100 md:group-focus-within/card:opacity-100 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                    <div className="absolute inset-x-1 bottom-1 flex justify-between transition-opacity md:opacity-0 md:group-hover/card:opacity-100 md:group-focus-within/card:opacity-100">
                      <Button
                        type="button"
                        disabled={disabled || index === 0}
                        onClick={() => onMoveFile(preview.key, -1)}
                        aria-label={`${moveBeforeLabel}: ${preview.file.name}`}
                        variant="ghost"
                        size="icon-xs"
                        className="h-6 w-6 rounded-full bg-(--scrim) text-(--text-primary) disabled:opacity-25"
                      >
                        <ArrowLeft className="h-3 w-3" />
                      </Button>
                      <Button
                        type="button"
                        disabled={disabled || index === filePreviews.length - 1}
                        onClick={() => onMoveFile(preview.key, 1)}
                        aria-label={`${moveAfterLabel}: ${preview.file.name}`}
                        variant="ghost"
                        size="icon-xs"
                        className="h-6 w-6 rounded-full bg-(--scrim) text-(--text-primary) disabled:opacity-25"
                      >
                        <ArrowRight className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
                {filePreviews.length < MAX_REFERENCE_FILES ? (
                  <Button
                    type="button"
                    disabled={disabled}
                    onClick={() => onOpenFilePicker()}
                    aria-label={addLabel}
                    variant="ghost"
                    size="icon"
                    className="pointer-events-auto ml-1 flex h-23 w-17 shrink-0 items-center justify-center rounded-(--radius-card) border border-dashed border-(--border-subtle) bg-(--bg-elevated) text-(--text-secondary) shadow-(--shadow-xs) transition-colors duration-(--motion-control) hover:border-(--border-active) hover:bg-(--bg-surface) hover:text-(--text-primary) disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <Plus className="h-6 w-6" />
                  </Button>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
});
