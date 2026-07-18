"use client";

import { useMemo } from "react";
import { normalizeLocale, type Locale } from "@/lib/i18n/locale";

/**
 * Static copy table for error boundaries (route + global). Used in places
 * where the I18nProvider may itself have crashed, so depending on `useT()`
 * would risk a second crash during recovery. Both `app/error.tsx` and
 * `app/global-error.tsx` consume this single source of truth.
 */
const ERROR_COPY = {
  en: {
    title: "Something went wrong",
    unexpected: "An unexpected error occurred.",
    retry: "Try again",
  },
  "zh-CN": {
    title: "出了点问题",
    unexpected: "发生了意外错误。",
    retry: "重试",
  },
  "zh-TW": {
    title: "出了點問題",
    unexpected: "發生了意外錯誤。",
    retry: "重試",
  },
} as const;

export type ErrorCopy = (typeof ERROR_COPY)[Locale];

export function useErrorCopy(): ErrorCopy {
  return useMemo(() => {
    const locale =
      typeof window === "undefined"
        ? "en"
        : normalizeLocale(window.navigator.language) ?? "en";
    return ERROR_COPY[locale];
  }, []);
}
