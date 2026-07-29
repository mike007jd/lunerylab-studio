// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/lib/i18n/messages/en";
import zhCN from "@/lib/i18n/messages/zh-CN";
import zhTW from "@/lib/i18n/messages/zh-TW";

const persistProfileLocale = vi.fn();
const routeState = { activePathname: "/settings" };

vi.mock("@/lib/client/persist-locale", () => ({
  persistProfileLocale: (...args: unknown[]) => persistProfileLocale(...args),
}));

vi.mock("@/components/motion/route-transition-provider", () => ({
  useRouteTransition: () => ({ activePathname: routeState.activePathname }),
}));

vi.mock("@/components/motion/motion-primitives", () => ({
  useMotionReducedPreference: () => true,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: (props: Record<string, unknown>) => <button type="button" {...props} />,
}));

import { TopHeader } from "@/components/layout/top-header";
import { I18nProvider, useI18n } from "@/lib/i18n/provider";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root;
let container: HTMLDivElement;
let observedLocale = "";

function LocaleProbe({ children }: { children: React.ReactNode }) {
  const { locale } = useI18n();
  useEffect(() => {
    observedLocale = locale;
  }, [locale]);
  return <>{children}</>;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  persistProfileLocale.mockReset();
  routeState.activePathname = "/settings";
  observedLocale = "";
  document.title = "preset title";
  document.documentElement.lang = "en";
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderHeader(locale: "en" | "zh-CN" | "zh-TW") {
  const messages = locale === "en" ? en : locale === "zh-CN" ? zhCN : zhTW;
  act(() => {
    root.render(
      <I18nProvider initialLocale={locale} initialMessages={messages}>
        <LocaleProbe>
          <TopHeader />
        </LocaleProbe>
      </I18nProvider>,
    );
  });
}

function localeToggleButton() {
  const prefixes = [en, zhCN, zhTW].map(
    (catalog) => catalog.shell.switchLanguageTo.split("{language}")[0]!,
  );
  return [...container.querySelectorAll("button")].find((button) =>
    prefixes.some((prefix) => (button.getAttribute("aria-label") ?? "").includes(prefix)),
  )!;
}

describe("TopHeader document locale chrome", () => {
  it("sets document lang and the localized title in English", () => {
    renderHeader("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe(`${en.nav.settings} — Lunery Lab Studio`);
  });

  it("sets document lang and the localized title in Simplified Chinese", () => {
    renderHeader("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.title).toBe(`${zhCN.nav.settings} — Lunery Lab Studio`);
  });

  it("PATCHes the profile locale then updates in-memory i18n only on success", async () => {
    persistProfileLocale.mockResolvedValue("en");
    renderHeader("zh-CN");
    expect(observedLocale).toBe("zh-CN");

    const toggle = localeToggleButton();
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(persistProfileLocale).toHaveBeenCalledWith("en");
    expect(observedLocale).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe(`${en.nav.settings} — Lunery Lab Studio`);
  });

  it("keeps the current locale when the profile PATCH fails", async () => {
    persistProfileLocale.mockRejectedValue(new Error("save failed"));
    renderHeader("zh-CN");

    const toggle = localeToggleButton();
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(persistProfileLocale).toHaveBeenCalledWith("en");
    expect(observedLocale).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.title).toBe(`${zhCN.nav.settings} — Lunery Lab Studio`);
  });

  it("surfaces a failed PATCH in a localized inline alert", async () => {
    persistProfileLocale.mockRejectedValue(new Error("save failed"));
    renderHeader("zh-CN");
    expect(container.querySelector('[role="alert"]')).toBeNull();

    const toggle = localeToggleButton();
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe(zhCN.shell.localeSaveError);
    expect(observedLocale).toBe("zh-CN");
  });

  it("shows the failure alert in each locale's own catalog", async () => {
    persistProfileLocale.mockRejectedValue(new Error("save failed"));

    renderHeader("en");
    await act(async () => {
      localeToggleButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(en.shell.localeSaveError);

    act(() => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    renderHeader("zh-TW");
    await act(async () => {
      localeToggleButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(zhTW.shell.localeSaveError);
  });

  it("clears the failure alert when a retry succeeds", async () => {
    persistProfileLocale.mockRejectedValueOnce(new Error("save failed"));
    renderHeader("zh-CN");

    const toggle = localeToggleButton();
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(observedLocale).toBe("zh-CN");

    persistProfileLocale.mockResolvedValue("en");
    await act(async () => {
      localeToggleButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(persistProfileLocale).toHaveBeenLastCalledWith("en");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(observedLocale).toBe("en");
  });

  it("does not clobber a project-specific document title", () => {
    routeState.activePathname = "/projects/project-1";
    document.title = "My Project — Lunery Lab Studio";
    renderHeader("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("My Project — Lunery Lab Studio");
  });
});
