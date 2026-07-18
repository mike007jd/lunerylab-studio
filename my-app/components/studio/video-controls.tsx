"use client";

import { memo, useMemo } from "react";
import type { VideoModelEntry } from "@/lib/video-models";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useI18n } from "@/lib/i18n/provider";
import { isChineseLocale } from "@/lib/i18n/locale";
import { useT } from "@/lib/i18n/useT";

interface VideoControlsProps {
  modelId: string;
  duration: number;
  onModelChange: (modelId: string) => void;
  onDurationChange: (duration: number) => void;
  models?: VideoModelEntry[];
  hasReferenceImage?: boolean;
}

function modelFreshnessLabel(model: VideoModelEntry, isZh: boolean): string | null {
  const verified = model.sourceEvidence?.[0]?.lastVerifiedAt;
  if (!verified) return null;
  const expires = model.freshnessExpiresAt;
  return isZh
    ? `已核对 ${verified}${expires ? `，${expires} 过期` : ""}`
    : `Verified ${verified}${expires ? `, expires ${expires}` : ""}`;
}

export const VideoControls = memo(function VideoControls({
  modelId,
  duration,
  onModelChange,
  onDurationChange,
  models = [],
  hasReferenceImage = true,
}: VideoControlsProps) {
  const { locale } = useI18n();
  const isZh = isChineseLocale(locale);
  const t = useT();
  const model = useMemo(
    () => models.find((entry) => entry.id === modelId || entry.providerModelId === modelId),
    [modelId, models],
  );
  return (
    <>
      {/* Model selector */}
      <Select
        value={models.length ? modelId : "__no_video_backend__"}
        onValueChange={onModelChange}
        disabled={models.length === 0}
      >
        <SelectTrigger
          size="sm"
          aria-label={t("canvas.videoModel")}
          className="h-8 min-w-0 gap-1 border-(--border-subtle) bg-transparent px-2 text-xs font-medium text-(--text-secondary) shadow-none hover:border-(--border-active)"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {models.length === 0 ? (
            <SelectItem value="__no_video_backend__" disabled>
              {t("studio.taskIntents.videoNoBackend")}
            </SelectItem>
          ) : models.map((m) => {
            const referenceMissing = m.requiresImageInput && !hasReferenceImage;
            return (
              <SelectItem key={m.id} value={m.id} disabled={referenceMissing}>
                <span className="flex flex-col gap-0.5">
                  <span>
                    {isZh ? m.labelZh : m.label}
                    {referenceMissing ? (isZh ? " (需要参考图)" : " (requires reference)") : ""}
                  </span>
                  {modelFreshnessLabel(m, isZh) ? (
                    <span className="text-[0.65rem] font-normal text-(--text-muted)">
                      {modelFreshnessLabel(m, isZh)}
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>

      {/* Duration picker — discrete buttons for Veo, slider for range models */}
      {model && model.durationMode === "discrete" && (
        <div className="flex gap-0.5">
          {model.durationOptions!.map((opt) => (
            <Button
              key={opt}
              variant={duration === opt ? "default" : "ghost"}
              size="chip"
              className="h-8 min-w-8 px-2 text-xs"
              onClick={() => onDurationChange(opt)}
            >
              {opt}s
            </Button>
          ))}
        </div>
      )}

      {model && model.durationMode === "range" && (
        <div className="flex items-center gap-1.5">
          <Slider
            min={model.durationRange![0]}
            max={model.durationRange![1]}
            value={[duration]}
            onValueChange={([next]) => {
              if (typeof next === "number") {
                onDurationChange(next);
              }
            }}
            className="w-20"
          />
          <span
            className="tabular-nums text-xs text-(--text-muted) min-w-6"
            title={
              model.capabilityVerified === false
                ? isZh
                  ? "时长与参考图能力取决于你配置的模型,未经核实"
                  : "Duration / reference support depends on your configured model; not verified"
                : undefined
            }
          >
            {model.capabilityVerified === false ? "~" : ""}
            {duration}s
          </span>
        </div>
      )}
    </>
  );
});
