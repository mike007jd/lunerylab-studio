"use client";

import type { ComponentProps, KeyboardEvent, RefObject } from "react";
import { ImagePlus, Send, Wand2 } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ImageModelEntry } from "@/lib/image-models";
import { ComposerDeck } from "@/components/studio/studio-composer-deck";
import { PresetPicker } from "@/components/studio/studio-preset-picker";
import { StudioOptionsPopover } from "@/components/studio/studio-options-popover";
import {
  COMPOSER_DECK_LAYOUT_CLASS,
  COMPOSER_TEXTAREA_OFFSET_CLASS,
} from "@/components/studio/studio-constants";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

export interface ComposerImageModelPickerProps {
  models: ImageModelEntry[];
  value: string;
  onChange: (value: string) => void;
  isZh: boolean;
  label: string;
  placeholder: string;
  noModelsLabel: string;
}

function ComposerImageModelPicker({
  models,
  value,
  onChange,
  isZh,
  label,
  placeholder,
  noModelsLabel,
}: ComposerImageModelPickerProps) {
  const { t } = useI18n();
  const localModels = models.filter((model) => model.source === "local");
  const byokModels = models.filter((model) => model.source === "byok");
  const cloudModels = models.filter((model) => !model.source || model.source === "cloud");
  const groups: Array<{ key: string; label: string; models: ImageModelEntry[] }> = [];

  if (localModels.length) groups.push({ key: "local", label: t("modelSource.local"), models: localModels });
  if (byokModels.length) groups.push({ key: "byok", label: t("modelSource.byok"), models: byokModels });
  if (cloudModels.length) groups.push({ key: "cloud", label: t("modelSource.cloud"), models: cloudModels });

  const selected = models.find(
    (model) => model.id === value || model.providerModelId === value,
  );

  return (
    <Select
      value={models.length ? value : "__no_image_backend__"}
      onValueChange={onChange}
      disabled={models.length === 0}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
        className="h-8 w-40 justify-between border-(--border-subtle) bg-transparent px-2 text-xs font-medium text-(--text-secondary) shadow-none hover:border-(--border-active) sm:w-48"
      >
        <SelectValue placeholder={placeholder}>
          {models.length === 0
            ? noModelsLabel
            : selected
              ? isZh
                ? selected.labelZh
                : selected.label
              : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {groups.length === 0 ? (
          <SelectItem value="__no_image_backend__" disabled>
            {noModelsLabel}
          </SelectItem>
        ) : (
          groups.map((group) => (
            <SelectGroup key={group.key}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {isZh ? model.labelZh : model.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

export interface StudioComposerProps {
  fileInputRef: RefObject<HTMLInputElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onFileChange: ComponentProps<typeof Input>["onChange"];
  referenceDeckProps: ComponentProps<typeof ComposerDeck>;
  prompt: string;
  onPromptChange: (value: string) => void;
  onPromptKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  mode: "image" | "video";
  onModeChange: (mode: "image" | "video") => void;
  imageRunMode: "single" | "batch";
  onImageRunModeChange: (mode: "single" | "batch") => void;
  imageModelPicker: ComposerImageModelPickerProps;
  presetPickerProps: ComponentProps<typeof PresetPicker>;
  optionsProps: ComponentProps<typeof StudioOptionsPopover>;
  activeProjectName?: string;
  referenceCount: number;
  canRefinePrompt: boolean;
  onRefinePrompt: () => void;
  isOptimizing: boolean;
  isGenerating: boolean;
  disabledRefineReason?: string;
  refineAction?: { href: string; label: string };
  onOpenRefineAction: (href: string) => void;
  modeCanGenerate: boolean;
  modeHasBackend: boolean;
  modeUnavailableReason?: string;
  videoNeedsReference: boolean;
  disabledGenerateReason?: string;
  onGenerate: () => void;
  imageOutputCount: number;
  notice: string;
  error: string;
}

export function StudioComposer({
  fileInputRef,
  textareaRef,
  onFileChange,
  referenceDeckProps,
  prompt,
  onPromptChange,
  onPromptKeyDown,
  placeholder,
  mode,
  onModeChange,
  imageRunMode,
  onImageRunModeChange,
  imageModelPicker,
  presetPickerProps,
  optionsProps,
  activeProjectName,
  referenceCount,
  canRefinePrompt,
  onRefinePrompt,
  isOptimizing,
  isGenerating,
  disabledRefineReason,
  refineAction,
  onOpenRefineAction,
  modeCanGenerate,
  modeHasBackend,
  modeUnavailableReason,
  videoNeedsReference,
  disabledGenerateReason,
  onGenerate,
  imageOutputCount,
  notice,
  error,
}: StudioComposerProps) {
  const { t } = useI18n();

  return (
    <div className="relative z-20 mx-auto w-full max-w-5xl">
      <Input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onFileChange}
      />

      <div
        className={cn(
          "group/composer relative overflow-hidden rounded-2xl border border-(--border-active) bg-(--bg-surface) px-4 py-3 shadow-[var(--shadow-lg),var(--shadow-glow)] transition-[border-color,box-shadow] duration-(--motion-control) focus-within:border-(--accent-primary)/40 sm:px-5 sm:py-4",
          COMPOSER_DECK_LAYOUT_CLASS,
        )}
      >
        <div className="pointer-events-none absolute inset-0 bg-linear-to-br from-(--bg-glass) via-transparent to-transparent" />

        <ComposerDeck {...referenceDeckProps} />

        <div className="relative">
          <Textarea
            id="studio-prompt-input"
            ref={textareaRef}
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={onPromptKeyDown}
            placeholder={placeholder}
            aria-label={t("studio.promptLabel")}
            rows={3}
            className={cn(
              "relative min-h-28 w-full resize-none border-0 bg-transparent px-4 pb-4 text-sm leading-relaxed text-foreground shadow-none outline-none ring-0 transition-colors placeholder:text-muted-foreground/50 focus:border-0 focus:placeholder:text-muted-foreground/40 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none focus-visible:outline-offset-0 focus-visible:ring-0 md:min-h-24 md:pt-5",
              referenceCount > 0
                ? "pt-28 pl-4 md:pl-[var(--composer-deck-offset)]"
                : cn("pt-2", COMPOSER_TEXTAREA_OFFSET_CLASS),
            )}
          />
        </div>

        <div className="relative mt-1.5 flex items-end justify-between gap-2 border-t border-(--border-subtle) pt-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ToggleGroup
              type="single"
              value={mode}
              onValueChange={(value) => {
                if (value === "image" || value === "video") onModeChange(value);
              }}
              className="rounded-md bg-(--bg-elevated) p-0.5"
              size="sm"
            >
              <ToggleGroupItem
                value="image"
                aria-label={t("studio.imageMode")}
                className="h-7 px-2.5 text-xs"
              >
                {t("studio.imageMode")}
              </ToggleGroupItem>
              <ToggleGroupItem
                value="video"
                aria-label={t("studio.videoMode")}
                className="h-7 px-2.5 text-xs"
              >
                {t("studio.videoMode")}
              </ToggleGroupItem>
            </ToggleGroup>

            {mode === "image" ? (
              <ToggleGroup
                type="single"
                value={imageRunMode}
                onValueChange={(value) => {
                  if (value === "single" || value === "batch") {
                    onImageRunModeChange(value);
                  }
                }}
                className="rounded-md bg-(--bg-elevated) p-0.5"
                size="sm"
              >
                <ToggleGroupItem value="single" className="h-7 px-2.5 text-xs">
                  {t("studio.singleMode")}
                </ToggleGroupItem>
                <ToggleGroupItem value="batch" className="h-7 px-2.5 text-xs">
                  {t("studio.batchMode")}
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}

            {mode === "image" ? (
              <ComposerImageModelPicker {...imageModelPicker} />
            ) : null}

            {mode === "image" ? <PresetPicker {...presetPickerProps} /> : null}

            <StudioOptionsPopover {...optionsProps} />

            {activeProjectName ? (
              <span
                className="max-w-44 truncate rounded-md border border-(--border-subtle) bg-(--bg-glass) px-2 py-1 text-xs text-(--text-secondary)"
                title={activeProjectName}
              >
                {t("studio.projectTarget", { name: activeProjectName })}
              </span>
            ) : null}

            {referenceCount > 0 ? (
              <span className="text-xs text-(--text-muted)">
                {t("studio.refsCount", { count: referenceCount })}
              </span>
            ) : null}

            {canRefinePrompt ? (
              <Button
                type="button"
                onClick={onRefinePrompt}
                loading={isOptimizing}
                disabled={isGenerating}
                variant="ghostMuted"
                size="xs"
                className="h-8 px-2.5"
              >
                <Wand2 className="h-3.5 w-3.5" />
                {t("studio.refinePrompt")}
              </Button>
            ) : prompt.trim() ? (
              <div className="flex basis-full items-center gap-2 text-xs text-(--text-muted)">
                <span className="min-w-0 flex-1 leading-snug">
                  {disabledRefineReason}
                </span>
                {refineAction ? (
                  <Button
                    type="button"
                    variant="ghostMuted"
                    size="xs"
                    className="h-7 shrink-0"
                    onClick={() => onOpenRefineAction(refineAction.href)}
                  >
                    {refineAction.label}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1">
            {modeCanGenerate ? (
              <span className="hidden text-xs leading-none text-(--text-muted) sm:block">
                {t("studio.shortcutHint")}
              </span>
            ) : null}
            {!modeHasBackend ? (
              <Button
                type="button"
                disabled
                variant="accent"
                size="cta"
                aria-label={t("studio.startGenerate")}
                title={modeUnavailableReason}
              >
                <Send className="h-4 w-4" />
                <span className="ml-1">{t("studio.startCrafting")}</span>
              </Button>
            ) : videoNeedsReference ? (
              <Button
                type="button"
                onClick={referenceDeckProps.onOpenFilePicker}
                disabled={isGenerating || isOptimizing}
                variant="accent"
                size="cta"
                aria-label={t("studio.addReference")}
              >
                <ImagePlus className="h-4 w-4" />
                <span className="ml-1">{t("studio.addReference")}</span>
              </Button>
            ) : (
              <Button
                type="button"
                onClick={onGenerate}
                loading={isGenerating}
                disabled={isOptimizing || isGenerating || !modeCanGenerate}
                variant="accent"
                size="cta"
                aria-label={t("studio.startGenerate")}
                title={disabledGenerateReason}
              >
                <Send className="h-4 w-4" />
                <span className="ml-1">
                  {imageRunMode === "batch"
                    ? t("studio.generateVariants", { count: imageOutputCount })
                    : t("studio.startCrafting")}
                </span>
              </Button>
            )}
          </div>
        </div>
      </div>

      {notice ? (
        <p
          role="status"
          aria-live="polite"
          className="px-5 pb-2 text-xs font-medium text-primary sm:px-6"
        >
          {notice}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          aria-live="assertive"
          className="px-5 pb-3 text-xs font-medium text-destructive sm:px-6"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
