"use client";

import { fetchJson } from "@/lib/client/fetch-json";
import { invalidateBootstrapSnapshot } from "@/lib/client/use-bootstrap-snapshot";
import { normalizeLocale, type Locale } from "@/lib/i18n/locale";

/**
 * Persist locale to the profile-backed settings API. Callers must update
 * in-memory i18n state only after this resolves successfully.
 */
export async function persistProfileLocale(locale: Locale): Promise<Locale> {
  const response = await fetchJson<{ app: { defaultLocale: string } }>("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultLocale: locale }),
  });
  invalidateBootstrapSnapshot();
  return normalizeLocale(response.app.defaultLocale) ?? locale;
}
