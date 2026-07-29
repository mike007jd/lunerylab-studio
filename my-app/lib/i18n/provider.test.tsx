// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import en from "@/lib/i18n/messages/en";
import { I18nProvider, useI18n } from "@/lib/i18n/provider";
import { LOCALE_COOKIE_KEY } from "@/lib/i18n/locale";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root;
let container: HTMLDivElement;
let latestLocale = "";

function Probe() {
  const { locale, setLocale } = useI18n();
  useEffect(() => {
    latestLocale = locale;
  }, [locale]);
  return (
    <button type="button" onClick={() => setLocale("zh-TW")}>
      switch
    </button>
  );
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  window.localStorage.clear();
  document.cookie = `${LOCALE_COOKIE_KEY}=; path=/; max-age=0`;
  latestLocale = "";
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("I18nProvider profile-backed locale", () => {
  it("does not treat localStorage as locale authority on mount", async () => {
    // Legacy browser key — intentionally not LOCALE_COOKIE_KEY / profile locale.
    window.localStorage.setItem("lunery-locale", "zh-CN");
    act(() => {
      root.render(
        <I18nProvider initialLocale="en" initialMessages={en}>
          <Probe />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(latestLocale).toBe("en");
    expect(window.localStorage.getItem("lunery-locale")).toBe("zh-CN");
  });

  it("mirrors successful in-memory locale changes into the SSR cookie only", async () => {
    act(() => {
      root.render(
        <I18nProvider initialLocale="en" initialMessages={en}>
          <Probe />
        </I18nProvider>,
      );
    });
    await act(async () => {
      container.querySelector("button")!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(latestLocale).toBe("zh-TW");
    expect(document.cookie).toContain(`${LOCALE_COOKIE_KEY}=zh-TW`);
    expect(window.localStorage.getItem("lunery-locale")).toBeNull();
  });
});
