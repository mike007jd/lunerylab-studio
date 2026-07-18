"use client";

import { SurfaceCard } from "@/components/ui/page-primitives";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useT } from "@/lib/i18n/useT";
import type { Locale } from "@/lib/i18n/locale";

const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
];

export function SettingsLanguageCard({
  locale,
  onLocaleChange,
  error,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  error?: string;
}) {
  const t = useT();

  return (
    <SurfaceCard>
      <h2 className="text-base font-semibold tracking-[-0.01em] text-(--text-primary)">
        {t("settings.language")}
      </h2>
      <RadioGroup
        value={locale}
        onValueChange={(value) => {
          if (value) onLocaleChange(value as Locale);
        }}
        aria-label={t("settings.language")}
        className="mt-4 flex flex-wrap items-center gap-2"
      >
        {LOCALE_OPTIONS.map((option) => (
          <RadioGroupItem
            key={option.value}
            value={option.value}
            className="aspect-auto h-10 w-auto rounded-lg border border-(--border-subtle) px-4 text-sm font-medium text-(--text-secondary) data-[state=checked]:border-(--border-active) data-[state=checked]:bg-(--bg-glass) data-[state=checked]:text-foreground"
          >
            {option.label}
          </RadioGroupItem>
        ))}
      </RadioGroup>
      {error ? (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SurfaceCard>
  );
}
