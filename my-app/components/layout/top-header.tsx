"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Globe } from "@/components/ui/icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useI18n } from "@/lib/i18n/provider";
import { isChineseLocale, type Locale } from "@/lib/i18n/locale";
import { useRouteTransition } from "@/components/motion/route-transition-provider";
import { useMotionReducedPreference } from "@/components/motion/motion-primitives";
import { lunaMotion } from "@/components/design-system/grammar/motion";

// Page titles resolve through the shared i18n catalog (the same `nav.*` keys
// the sidebar uses) so every locale — including zh-TW — renders in its own
// script and stays in sync with the navigation labels. A hardcoded map here
// previously collapsed zh-TW to Simplified Chinese.
const PAGE_TITLE_KEYS: Array<{ path: string; key: string }> = [
  { path: "/studio", key: "nav.studio" },
  { path: "/library", key: "nav.library" },
  { path: "/settings", key: "nav.settings" },
  { path: "/projects", key: "nav.projects" },
];
function resolvePageTitleKey(pathname: string): string | null {
  const matched = PAGE_TITLE_KEYS.find(
    ({ path }) => pathname === path || pathname.startsWith(path + "/")
  );
  return matched?.key ?? null;
}

// Traditional-Chinese variant to render as the "中" label when active, so the
// toggle reads 繁 for zh-TW users and doesn't imply they'll be sent to Simplified.
type ChineseVariant = "zh-CN" | "zh-TW";

function TapScale({
  children,
  reduced,
}: {
  children: React.ReactNode;
  reduced: boolean;
}) {
  return (
    <motion.div whileTap={reduced ? undefined : { scale: 0.95 }} transition={lunaMotion.feedback}>
      {children}
    </motion.div>
  );
}

export function TopHeader() {
  const reduced = useMotionReducedPreference();
  const { activePathname } = useRouteTransition();
  const { locale, setLocale, t } = useI18n();

  const isEnglish = locale === "en";
  // Remember the last Chinese variant the user was on so English → 中 restores
  // it instead of hard-coding Simplified. Uses React's "adjust state during
  // render" pattern (conditional setState, no effect) so it never lags a frame;
  // zh-TW users toggle en ↔ zh-TW. The full three-way picker lives in Settings.
  const [lastChineseVariant, setLastChineseVariant] = useState<ChineseVariant>(
    isChineseLocale(locale) ? (locale as ChineseVariant) : "zh-CN"
  );
  if (isChineseLocale(locale) && locale !== lastChineseVariant) {
    setLastChineseVariant(locale as ChineseVariant);
  }

  const nextLocale: Locale = isEnglish ? lastChineseVariant : "en";
  const localeToggleLabel = isEnglish ? (lastChineseVariant === "zh-TW" ? "繁" : "中") : "EN";
  const nextLocaleName =
    nextLocale === "en"
      ? t("shell.languageEnglish")
      : nextLocale === "zh-TW"
        ? t("shell.languageTraditionalChinese")
        : t("shell.languageSimplifiedChinese");
  const handleLocaleToggle = () => setLocale(nextLocale);

  const titleKey = resolvePageTitleKey(activePathname);
  const title = titleKey ? t(titleKey) : "";
  const projectDetailOwnsHeading = /^\/projects\/[^/]+$/.test(activePathname);
  return (
    <header
      className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-(--border-subtle) bg-(--bg-base)/82 px-5 backdrop-blur-md"
    >
      {/* Persistent shell control remains available at every window width, so a
          hidden desktop sidebar always has a visible recovery path. */}
      <div className="flex items-center gap-2">
        <SidebarTrigger
          className="mr-1 size-9"
          aria-label={t("shell.toggleNavigation")}
          title={t("shell.toggleNavigation")}
        />
        {title ? (
          projectDetailOwnsHeading ? (
            <span className="text-xs font-semibold text-(--text-secondary)">{title}</span>
          ) : (
            <h1 className="text-xs font-semibold text-(--text-secondary)">{title}</h1>
          )
        ) : null}
      </div>

      {/* Right: low-noise locale utility; creative readiness stays contextual. */}
      <div className="flex items-center gap-1.5">
        <TapScale reduced={reduced}>
          <Button
            variant="ghostMuted"
            size="toolbar"
            onClick={handleLocaleToggle}
            aria-label={t("shell.switchLanguageTo", { language: nextLocaleName })}
            title={t("shell.switchLanguageTo", { language: nextLocaleName })}
            className="h-9 min-w-9 gap-1.5 px-2.5"
          >
            <Globe className="h-3.5 w-3.5" aria-hidden />
            {localeToggleLabel}
          </Button>
        </TapScale>
      </div>
    </header>
  );
}
