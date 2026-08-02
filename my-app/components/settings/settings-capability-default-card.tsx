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

export function isPersistedDefaultUnavailable(
  value: string,
  options: ReadonlyArray<{ id: string }>,
  loading = false,
  catalogError = false,
): boolean {
  return !loading && !catalogError && Boolean(value) && !options.some((option) => option.id === value);
}

export function SettingsCapabilityDefaultCard({
  capability,
  value,
  options,
  loading,
  catalogError,
  saving,
  changed,
  feedback,
  onChange,
  onSave,
  onClear,
}: {
  capability: "text" | "video";
  value: string;
  options: CapabilityModelOption[];
  loading: boolean;
  catalogError: boolean;
  saving: boolean;
  changed: boolean;
  feedback: { tone: "success" | "error"; text: string } | null;
  onChange: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  const t = useT();
  const title = capability === "text"
    ? t("settings.defaultTextModel")
    : t("settings.defaultVideoModel");
  const unavailable = isPersistedDefaultUnavailable(value, options, loading, catalogError);
  const configured = Boolean(value) && !unavailable;

  return (
    <SurfaceCard className="space-y-4" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-(--text-primary)">{title}</h2>
        <span className="rounded-full border border-(--border-subtle) bg-(--bg-glass) px-2 py-1 text-[0.7rem] font-medium text-(--text-muted)">
          {loading
            ? t("common.loading")
            : catalogError
              ? t("settings.modelCatalogUnavailable")
            : unavailable
            ? t("settings.defaultModelUnavailable")
            : configured
              ? t("settings.realGenerationEnabled")
              : t("settings.notConfigured")}
        </span>
      </div>
      {loading ? (
        <p className="rounded-lg border border-dashed border-(--border-subtle) bg-(--bg-glass) p-4 text-xs leading-5 text-(--text-secondary)">
          {t("common.loading")}
        </p>
      ) : catalogError ? (
        <p role="alert" className="rounded-lg border border-dashed border-(--border-subtle) bg-(--bg-glass) p-4 text-xs leading-5 text-(--text-secondary)">
          {t("settings.modelCatalogUnavailableHint")}
        </p>
      ) : unavailable ? (
        <div className="space-y-3 rounded-lg border border-dashed border-(--border-subtle) bg-(--bg-glass) p-4">
          <p className="text-xs leading-5 text-(--text-secondary)">
            {t("settings.defaultModelUnavailableHint")}
          </p>
          <Button
            type="button"
            variant="secondary"
            loading={saving}
            onClick={onClear}
          >
            {t("settings.clearDefaultModel")}
          </Button>
        </div>
      ) : options.length === 0 ? (
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
      {!loading && !catalogError && !unavailable ? (
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
      ) : feedback ? (
        <p role="status" aria-live="polite" className={feedback.tone === "success" ? "text-sm text-(--success)" : "text-sm text-destructive"}>
          {feedback.text}
        </p>
      ) : null}
    </SurfaceCard>
  );
}
