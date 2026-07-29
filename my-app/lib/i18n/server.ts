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
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import {
  LOCAL_WORKSPACE_OWNER,
  ensureLocalWorkspaceOwner,
  getLocalWorkspacePreferences,
} from "@/lib/server/local-workspace-owner";

/**
 * Resolve current locale: profile DB (canonical) → cookie SSR mirror →
 * Accept-Language → default.
 */
export async function resolveLocale(): Promise<Locale> {
  if (isDesktopRuntime()) {
    try {
      await ensureLocalWorkspaceOwner();
      const settings = await getLocalWorkspacePreferences(LOCAL_WORKSPACE_OWNER.id);
      const fromProfile = normalizeLocale(settings.defaultLocale);
      if (fromProfile) {
        return fromProfile;
      }
    } catch {
      // Workspace may be unavailable during early boot; fall through.
    }
  }

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
