export const LOCALE_STORAGE_KEY = "lunery-locale";
export const LOCALE_COOKIE_KEY = "lunery-locale";

export const SUPPORTED_LOCALES = ["en", "zh-CN", "zh-TW"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export function normalizeLocale(raw?: string | null): Locale | undefined {
  if (!raw) {
    return undefined;
  }

  const lower = raw.toLowerCase();
  // Traditional Chinese: zh-TW, zh-Hant, zh-HK, zh-MO (use startsWith to handle Unicode extension tags)
  if (
    lower.startsWith("zh-tw") ||
    lower.startsWith("zh-hk") ||
    lower.startsWith("zh-mo") ||
    lower.startsWith("zh-hant")
  ) {
    return "zh-TW";
  }
  if (lower.startsWith("zh")) {
    return "zh-CN";
  }
  if (lower.startsWith("en")) {
    return "en";
  }
  return undefined;
}

export function isChineseLocale(locale: Locale): boolean {
  return locale === "zh-CN" || locale === "zh-TW";
}

export function detectLocaleFromAcceptLanguage(acceptLanguage?: string | null): Locale {
  if (!acceptLanguage) {
    return "en";
  }

  const parts = acceptLanguage
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const locale = normalizeLocale(part);
    if (locale) {
      return locale;
    }
  }

  return "en";
}
