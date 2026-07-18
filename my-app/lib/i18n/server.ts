import { cookies, headers } from "next/headers";
import {
  LOCALE_COOKIE_KEY,
  normalizeLocale,
  detectLocaleFromAcceptLanguage,
  type Locale,
} from "@/lib/i18n/locale";
import {
  getPlainT,
  messageCatalog,
  type Messages,
} from "@/lib/i18n/plain";

/**
 * Resolve current locale from cookie → Accept-Language header → default.
 * Use in Server Components and generateMetadata.
 */
export async function resolveLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const headerStore = await headers();
  return (
    normalizeLocale(cookieStore.get(LOCALE_COOKIE_KEY)?.value) ??
    detectLocaleFromAcceptLanguage(headerStore.get("accept-language"))
  );
}

/**
 * Server-side translation lookup — for use in generateMetadata and Server Components.
 */
export const getT = getPlainT;

export function getMessages(locale: Locale): Messages {
  return messageCatalog[locale];
}
