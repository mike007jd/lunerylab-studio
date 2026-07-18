import { describe, expect, it } from "vitest";
import { SIDEBAR_RECENT_PROJECT_LIMIT } from "@/lib/constants/shell-navigation";
import { getPlainT } from "@/lib/i18n/plain";
import type { Locale } from "@/lib/i18n/locale";

const LOCALES: Locale[] = ["en", "zh-CN", "zh-TW"];

describe("shell information architecture", () => {
  it("bounds recent project shortcuts", () => {
    expect(SIDEBAR_RECENT_PROJECT_LIMIT).toBe(6);
  });

  it.each(LOCALES)("provides localized shell accessibility copy for %s", (locale) => {
    const t = getPlainT(locale);

    expect(t("nav.recentProjects")).not.toBe("nav.recentProjects");
    expect(t("shell.navigationTitle")).not.toBe("shell.navigationTitle");
    expect(t("shell.navigationDescription")).not.toBe("shell.navigationDescription");
    expect(t("shell.closeNavigation")).not.toBe("shell.closeNavigation");
    expect(t("shell.toggleNavigation")).not.toBe("shell.toggleNavigation");
    expect(t("shell.goToStudio")).not.toBe("shell.goToStudio");
    expect(t("shell.switchLanguageTo", { language: "Test" })).toContain("Test");
  });
});
