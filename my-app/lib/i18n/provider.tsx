"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  LOCALE_COOKIE_KEY,
  LOCALE_STORAGE_KEY,
  type Locale,
  normalizeLocale,
} from "@/lib/i18n/locale";
import { interpolateMessage, lookupMessage, warnMissingKey, type Messages } from "@/lib/i18n/plain";
import enMessages from "@/lib/i18n/messages/en";

export type { Messages };

export type TFunction = (path: string, vars?: Record<string, string | number>) => string;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFunction;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function persistLocale(locale: Locale) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const secureFlag = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LOCALE_COOKIE_KEY}=${locale}; path=/; max-age=31536000; SameSite=Lax${secureFlag}`;
}

async function loadMessages(locale: Locale): Promise<Messages> {
  switch (locale) {
    case "en":
      return (await import("@/lib/i18n/messages/en")).default;
    case "zh-TW":
      return (await import("@/lib/i18n/messages/zh-TW")).default;
    case "zh-CN":
    default:
      return (await import("@/lib/i18n/messages/zh-CN")).default;
  }
}

interface I18nProviderProps {
  initialLocale: Locale;
  initialMessages: Messages;
  children: React.ReactNode;
}

export function I18nProvider({ initialLocale, initialMessages, children }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [messages, setMessages] = useState<Messages>(initialMessages);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    const storedLocale = normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
    const preferredLocale = storedLocale ?? initialLocale;

    const timer = window.setTimeout(() => {
      if (preferredLocale === initialLocale) return;
      const seq = ++loadSeqRef.current;
      void loadMessages(preferredLocale).then((nextMessages) => {
        if (seq !== loadSeqRef.current) return;
        setMessages(nextMessages);
        setLocaleState(preferredLocale);
      });
    }, 0);

    persistLocale(preferredLocale);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLocale = useCallback((nextLocale: Locale) => {
    persistLocale(nextLocale);
    const seq = ++loadSeqRef.current;
    void loadMessages(nextLocale).then((nextMessages) => {
      if (seq !== loadSeqRef.current) return;
      setMessages(nextMessages);
      setLocaleState(nextLocale);
    });
  }, []);

  const t: TFunction = useCallback(
    (path: string, vars?: Record<string, string | number>) => {
      const message = lookupMessage(messages, path);
      const fallback = message === path && locale !== "en" ? lookupMessage(enMessages, path) : message;
      if (fallback === path) warnMissingKey(path, locale);
      return interpolateMessage(fallback, vars);
    },
    [locale, messages],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}
