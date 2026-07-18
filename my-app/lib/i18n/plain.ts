import en from "@/lib/i18n/messages/en";
import zhCN from "@/lib/i18n/messages/zh-CN";
import zhTW from "@/lib/i18n/messages/zh-TW";
import type { Locale } from "@/lib/i18n/locale";

export type Messages = {
  [key: string]: string | Messages;
};

const INTERPOLATE_RE = /\{(\w+)\}/g;

export const messageCatalog: Record<Locale, Messages> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

export function lookupMessage(messages: Messages, path: string): string {
  const value = path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, messages);

  return typeof value === "string" ? value : path;
}

export function interpolateMessage(template: string, vars?: Record<string, string | number>) {
  if (!vars) return template;
  return template.replace(INTERPOLATE_RE, (_, key: string) => String(vars[key] ?? `{${key}}`));
}

// Dev-only guard: a missing key silently renders the raw path (e.g. a
// wrong-namespace call-site leaks "studio.setupHint.title" into the UI). Warn
// once per key in non-production so these surface at dev/build time instead of
// via a hand audit. Deduped so it never spams the console/logs.
const warnedMissingKeys = new Set<string>();
export function warnMissingKey(path: string, locale: Locale) {
  if (process.env.NODE_ENV === "production") return;
  if (warnedMissingKeys.has(path)) return;
  warnedMissingKeys.add(path);
  console.warn(
    `[i18n] missing key "${path}" (not in "${locale}" or the "en" fallback) — rendering the raw key`,
  );
}

export function getPlainT(locale: Locale) {
  const messages = messageCatalog[locale];

  return (path: string, vars?: Record<string, string | number>) => {
    const message = lookupMessage(messages, path);
    const fallback = message === path && locale !== "en" ? lookupMessage(en, path) : message;
    if (fallback === path) warnMissingKey(path, locale);
    return interpolateMessage(fallback, vars);
  };
}
