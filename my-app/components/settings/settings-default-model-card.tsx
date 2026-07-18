"use client";

import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "@/components/ui/icons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SurfaceCard } from "@/components/ui/page-primitives";
import type { ImageModelEntry } from "@/lib/image-models";
import { useT } from "@/lib/i18n/useT";
import { isChineseLocale, type Locale } from "@/lib/i18n/locale";

const NO_DEFAULT_MODEL_VALUE = "__lunery_no_default_model__";

export function SettingsDefaultModelCard({
  defaultModel,
  disabled,
  feedback,
  locale,
  models,
  onModelChange,
  onSave,
  saving,
}: {
  defaultModel: string;
  disabled: boolean;
  feedback: { tone: "success" | "error"; text: string } | null;
  locale: Locale;
  models: ImageModelEntry[];
  onModelChange: (model: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const isZh = isChineseLocale(locale);
  const hasModels = models.length > 0;

  return (
    <SurfaceCard className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-(--text-primary)">
          {t("settings.defaultModel")}
        </h2>
        <p className="rounded-full border border-(--border-subtle) bg-(--bg-glass) px-2 py-1 text-[0.7rem] font-medium text-(--text-muted)">
          {t("settings.realGenerationStatus", {
            status: defaultModel
              ? t("settings.realGenerationEnabled")
              : t("settings.notConfigured"),
          })}
        </p>
      </div>

      {/* No model exists yet → dead-end Select + disabled Save is replaced by a
          real next step. Keeps the no-default rule (we never preselect a model). */}
      {!hasModels ? (
        <div className="space-y-3 rounded-xl border border-dashed border-(--border-subtle) bg-(--bg-glass) p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-(--text-primary)">
              {t("studio.setupHint.title")}
            </p>
            <p className="text-xs leading-5 text-(--text-secondary)">
              {t("studio.setupHint.descriptionImage")}
            </p>
          </div>
          <Button
            type="button"
            variant="accent"
            onClick={() => router.replace(`${pathname}?panel=provider-connections`, { scroll: false })}
          >
            {t("studio.connectModel")}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <>
      <Select
        value={defaultModel || NO_DEFAULT_MODEL_VALUE}
        onValueChange={(value) => onModelChange(value === NO_DEFAULT_MODEL_VALUE ? "" : value)}
      >
        <SelectTrigger
          aria-label={t("settings.defaultModel")}
          className="h-11 w-full border-(--border-subtle) bg-(--bg-elevated) text-(--text-primary)"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_DEFAULT_MODEL_VALUE}>
            {t("settings.noDefaultModel")}
          </SelectItem>
          {models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              {isZh ? model.brandZh : model.brand}
              {" — "}
              {isZh ? model.labelZh : model.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="accent" onClick={onSave} loading={saving} disabled={disabled}>
          {t("settings.save")}
        </Button>
        {feedback ? (
          <p
            role="status"
            aria-live="polite"
            className={feedback.tone === "success" ? "text-sm text-(--success)" : "text-sm text-destructive"}
          >
            {feedback.text}
          </p>
        ) : null}
      </div>
        </>
      )}
    </SurfaceCard>
  );
}
