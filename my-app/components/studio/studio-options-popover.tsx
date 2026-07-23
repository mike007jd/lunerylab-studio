"use client";

import { memo, type ReactNode } from "react";
import { Settings } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/lib/i18n/provider";
import { ASPECT_RATIOS } from "@/lib/constants/generation";
import {
  resolveImageAdvancedParameters,
  supportsAnyAdvancedImageParameter,
  type ImageModelEntry,
} from "@/lib/image-models";
import type { VideoModelEntry } from "@/lib/video-models";
import type { StylePreset } from "@/lib/presets/style-presets";
import type { ProjectOption } from "@/components/studio/studio-constants";
import { VideoControls } from "@/components/studio/video-controls";
import { formatGenerationOptionsSummary } from "@/lib/client/generation-presentation";
import { AdvancedDisclosure } from "@/components/ui/advanced-disclosure";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  GENERATION_PARAMETER_LIMITS,
  type GenerationParameters,
} from "@/lib/generation-parameters";

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs font-semibold text-(--text-muted)">
      {children}
    </span>
  );
}

function ImageModelSelect({
  value,
  models,
  disabled,
  onChange,
  isZh,
  noBackendLabel,
  ariaLabel,
}: {
  value: string;
  models: ImageModelEntry[];
  disabled: boolean;
  onChange: (value: string) => void;
  isZh: boolean;
  noBackendLabel: string;
  ariaLabel: string;
}) {
  const { t } = useI18n();
  const localModels = models.filter((model) => model.source === "local");
  const byokModels = models.filter((model) => model.source === "byok");
  const cloudModels = models.filter((model) => !model.source || model.source === "cloud");
  const groups: Array<{ key: string; label: string; models: ImageModelEntry[] }> = [];

  if (localModels.length) groups.push({ key: "local", label: t("modelSource.local"), models: localModels });
  if (byokModels.length) groups.push({ key: "byok", label: t("modelSource.byok"), models: byokModels });
  if (cloudModels.length) groups.push({ key: "cloud", label: t("modelSource.cloud"), models: cloudModels });

  return (
    <div className="space-y-1.5">
      <Select
        value={models.length ? value : "__no_image_backend__"}
        onValueChange={onChange}
        disabled={disabled}
      >
        <SelectTrigger
          size="sm"
          aria-label={ariaLabel}
          className="h-8 w-full justify-between border-(--border-subtle) bg-transparent px-2 text-xs font-medium text-(--text-secondary) shadow-none hover:border-(--border-active)"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {groups.length === 0 ? (
            <SelectItem value="__no_image_backend__" disabled>
              {noBackendLabel}
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
    </div>
  );
}

function ProjectSelect({
  value,
  projects,
  onChange,
  onCreate,
  isCreating,
  labels,
}: {
  value: string;
  projects: ProjectOption[];
  onChange: (value: string) => void;
  onCreate: () => void;
  isCreating: boolean;
  labels: {
    selectProject: string;
    noProjects: string;
    newProject: string;
  };
}) {
  return (
    <div className="flex gap-2">
      <Select
        value={projects.length ? value : "__none__"}
        onValueChange={(next) => {
          if (next !== "__none__") onChange(next);
        }}
        disabled={projects.length === 0}
      >
        <SelectTrigger
          size="sm"
          aria-label={labels.selectProject}
          className="h-8 min-w-0 flex-1 justify-between border-(--border-subtle) bg-transparent px-2 text-xs font-medium text-(--text-secondary) shadow-none hover:border-(--border-active)"
        >
          <SelectValue placeholder={labels.noProjects} />
        </SelectTrigger>
        <SelectContent>
          {projects.length === 0 ? (
            <SelectItem value="__none__" disabled>
              {labels.noProjects}
            </SelectItem>
          ) : (
            projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="mutedOutline"
        size="chip"
        onClick={onCreate}
        loading={isCreating}
        disabled={isCreating}
        className="px-2.5"
      >
        + {labels.newProject}
      </Button>
    </div>
  );
}

interface StudioOptionsPopoverProps {
  mode: "image" | "video";
  imageModels: ImageModelEntry[];
  activeImageModelId: string;
  hasImageModels: boolean;
  onImageModelChange: (value: string) => void;
  aspectRatio: string;
  onAspectRatioChange: (value: string) => void;
  candidateCount: number;
  selectedPreset: StylePreset | null;
  videoModels: VideoModelEntry[];
  selectedVideoModelId: string;
  videoDuration: number;
  onVideoModelChange: (value: string) => void;
  onVideoDurationChange: (value: number) => void;
  hasVideoReference: boolean;
  projectId: string;
  projects: ProjectOption[];
  onProjectChange: (value: string) => void;
  onCreateProject: () => void;
  isCreatingProject: boolean;
  isZh: boolean;
  generationParameters: GenerationParameters;
  onGenerationParametersChange: (parameters: GenerationParameters) => void;
  labels: {
    options: string;
    model: string;
    output: string;
    project: string;
    imageModel: string;
    noBackend: string;
    aspectRatio: string;
    variants: string;
    selectProject: string;
    noProjects: string;
    newProject: string;
    advanced: string;
    seed: string;
    seedRandom: string;
    steps: string;
    cfg: string;
    automatic: string;
    negativePrompt: string;
  };
}

export const StudioOptionsPopover = memo(function StudioOptionsPopover({
  mode,
  imageModels,
  activeImageModelId,
  hasImageModels,
  onImageModelChange,
  aspectRatio,
  onAspectRatioChange,
  candidateCount,
  selectedPreset,
  videoModels,
  selectedVideoModelId,
  videoDuration,
  onVideoModelChange,
  onVideoDurationChange,
  hasVideoReference,
  projectId,
  projects,
  onProjectChange,
  onCreateProject,
  isCreatingProject,
  isZh,
  generationParameters,
  onGenerationParametersChange,
  labels,
}: StudioOptionsPopoverProps) {
  const outputCount = selectedPreset?.batchVariants?.length ?? candidateCount;
  const summary = mode === "image"
    ? formatGenerationOptionsSummary(aspectRatio, outputCount)
    : `${videoDuration}s`;
  const selectedImageModel = imageModels.find(
    (model) => model.id === activeImageModelId || model.providerModelId === activeImageModelId,
  );
  const advancedCapabilities = resolveImageAdvancedParameters(selectedImageModel);
  const showAdvanced = supportsAnyAdvancedImageParameter(advancedCapabilities);
  const advancedFieldCount = [
    advancedCapabilities.seed,
    advancedCapabilities.steps,
    advancedCapabilities.cfg,
  ].filter(Boolean).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="mutedOutline"
          size="xs"
          className="h-8 gap-1.5 px-2.5"
          aria-label={`${labels.options}: ${summary}`}
        >
          <Settings className="h-3.5 w-3.5" />
          <span>{summary}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        className="w-[min(380px,calc(100vw-24px))] space-y-4 rounded-xl border border-(--border-active) bg-(--bg-elevated) p-3 shadow-[var(--shadow-lg)]"
      >
        <div className="space-y-1.5">
          <FieldLabel>{labels.model}</FieldLabel>
          {mode === "image" ? (
            <ImageModelSelect
              value={activeImageModelId}
              models={imageModels}
              disabled={!hasImageModels}
              onChange={onImageModelChange}
              isZh={isZh}
              noBackendLabel={labels.noBackend}
              ariaLabel={labels.imageModel}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <VideoControls
                modelId={selectedVideoModelId}
                duration={videoDuration}
                onModelChange={onVideoModelChange}
                onDurationChange={onVideoDurationChange}
                models={videoModels}
                hasReferenceImage={hasVideoReference}
              />
            </div>
          )}
        </div>

        {mode === "image" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <FieldLabel>{labels.aspectRatio}</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                {ASPECT_RATIOS.map((ar) => (
                  <Button
                    key={ar.value}
                    type="button"
                    size="chip"
                    aria-pressed={aspectRatio === ar.value}
                    variant={aspectRatio === ar.value ? "selected" : "ghostMuted"}
                    onClick={() => onAspectRatioChange(ar.value)}
                  >
                    {ar.label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <FieldLabel>{labels.output}</FieldLabel>
              <div className="flex h-8 items-center rounded-md border border-(--border-subtle) px-2 text-xs font-medium text-(--text-secondary)">
                {outputCount} {labels.variants}
              </div>
            </div>

            {showAdvanced ? (
              <AdvancedDisclosure title={labels.advanced}>
                {advancedFieldCount > 0 ? (
                  <div
                    className={
                      advancedFieldCount === 1
                        ? "grid grid-cols-1 gap-2"
                        : advancedFieldCount === 2
                          ? "grid grid-cols-2 gap-2"
                          : "grid grid-cols-3 gap-2"
                    }
                  >
                    {advancedCapabilities.seed ? (
                      <label className="space-y-1">
                        <FieldLabel>{labels.seed}</FieldLabel>
                        <Input
                          type="number"
                          min={GENERATION_PARAMETER_LIMITS.seed.min}
                          max={GENERATION_PARAMETER_LIMITS.seed.max}
                          value={generationParameters.seed ?? ""}
                          placeholder={labels.seedRandom}
                          onChange={(event) => onGenerationParametersChange({
                            ...generationParameters,
                            seed: event.target.value ? Number(event.target.value) : undefined,
                          })}
                          className="h-8 text-xs"
                        />
                      </label>
                    ) : null}
                    {advancedCapabilities.steps ? (
                      <label className="space-y-1">
                        <FieldLabel>{labels.steps}</FieldLabel>
                        <Input
                          type="number"
                          min={GENERATION_PARAMETER_LIMITS.steps.min}
                          max={GENERATION_PARAMETER_LIMITS.steps.max}
                          value={generationParameters.steps ?? ""}
                          placeholder={labels.automatic}
                          onChange={(event) => onGenerationParametersChange({
                            ...generationParameters,
                            steps: event.target.value ? Number(event.target.value) : undefined,
                          })}
                          className="h-8 text-xs"
                        />
                      </label>
                    ) : null}
                    {advancedCapabilities.cfg ? (
                      <label className="space-y-1">
                        <FieldLabel>{labels.cfg}</FieldLabel>
                        <Input
                          type="number"
                          min={GENERATION_PARAMETER_LIMITS.cfg.min}
                          max={GENERATION_PARAMETER_LIMITS.cfg.max}
                          step="0.5"
                          value={generationParameters.cfg ?? ""}
                          placeholder={labels.automatic}
                          onChange={(event) => onGenerationParametersChange({
                            ...generationParameters,
                            cfg: event.target.value ? Number(event.target.value) : undefined,
                          })}
                          className="h-8 text-xs"
                        />
                      </label>
                    ) : null}
                  </div>
                ) : null}
                {advancedCapabilities.negativePrompt ? (
                  <label className="block space-y-1">
                    <FieldLabel>{labels.negativePrompt}</FieldLabel>
                    <Textarea
                      value={generationParameters.negativePrompt ?? ""}
                      maxLength={GENERATION_PARAMETER_LIMITS.negativePromptMaxLength}
                      rows={2}
                      onChange={(event) => onGenerationParametersChange({
                        ...generationParameters,
                        negativePrompt: event.target.value || undefined,
                      })}
                      className="min-h-16 resize-none text-xs"
                    />
                  </label>
                ) : null}
              </AdvancedDisclosure>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <FieldLabel>{labels.project}</FieldLabel>
          <ProjectSelect
            value={projectId}
            projects={projects}
            onChange={onProjectChange}
            onCreate={onCreateProject}
            isCreating={isCreatingProject}
            labels={{
              selectProject: labels.selectProject,
              noProjects: labels.noProjects,
              newProject: labels.newProject,
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
});
