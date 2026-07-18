"use client";

import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/ui/page-primitives";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/useT";

const EMPTY_VALUE = "__lunery_no_default_model__";

export interface CapabilityModelOption {
  id: string;
  label: string;
}

export function SettingsCapabilityDefaultCard({
  capability,
  value,
  options,
  saving,
  changed,
  feedback,
  onChange,
  onSave,
}: {
  capability: "text" | "video";
  value: string;
  options: CapabilityModelOption[];
  saving: boolean;
  changed: boolean;
  feedback: { tone: "success" | "error"; text: string } | null;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const t = useT();
  const title = capability === "text"
    ? t("settings.defaultTextModel")
    : t("settings.defaultVideoModel");

  return (
    <SurfaceCard className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-(--text-primary)">{title}</h2>
        <span className="rounded-full border border-(--border-subtle) bg-(--bg-glass) px-2 py-1 text-[0.7rem] font-medium text-(--text-muted)">
          {value ? t("settings.realGenerationEnabled") : t("settings.notConfigured")}
        </span>
      </div>
      {options.length === 0 ? (
        <p className="rounded-lg border border-dashed border-(--border-subtle) bg-(--bg-glass) p-4 text-xs leading-5 text-(--text-secondary)">
          {t(`settings.noCapabilityModels.${capability}`)}
        </p>
      ) : (
        <Select
          value={value || EMPTY_VALUE}
          onValueChange={(next) => onChange(next === EMPTY_VALUE ? "" : next)}
        >
          <SelectTrigger aria-label={title} className="h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={EMPTY_VALUE}>{t("settings.noDefaultModel")}</SelectItem>
            {options.map((option) => (
              <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="accent" loading={saving} disabled={!changed} onClick={onSave}>
          {t("settings.save")}
        </Button>
        {feedback ? (
          <p role="status" aria-live="polite" className={feedback.tone === "success" ? "text-sm text-(--success)" : "text-sm text-destructive"}>
            {feedback.text}
          </p>
        ) : null}
      </div>
    </SurfaceCard>
  );
}
