"use client";

import { useEffect, useRef } from "react";
import { useSharedBootstrapSnapshot } from "@/lib/client/bootstrap-snapshot-provider";
import { normalizeLocale } from "@/lib/i18n/locale";
import { useI18n } from "@/lib/i18n/provider";

/**
 * When the shared bootstrap snapshot's profile locale changes (restore, settings
 * PATCH elsewhere, poll), update in-memory i18n without a full reload.
 */
export function BootstrapLocaleSync() {
  const snapshot = useSharedBootstrapSnapshot();
  const { locale, setLocale } = useI18n();
  const lastAppliedRef = useRef(locale);

  useEffect(() => {
    const next = normalizeLocale(snapshot?.app.defaultLocale);
    if (!next || next === lastAppliedRef.current) return;
    lastAppliedRef.current = next;
    if (next !== locale) {
      setLocale(next);
    }
  }, [locale, setLocale, snapshot?.app.defaultLocale]);

  return null;
}
