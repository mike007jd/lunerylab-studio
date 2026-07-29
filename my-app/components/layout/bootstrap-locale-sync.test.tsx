// @vitest-environment happy-dom

import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/lib/i18n/messages/en";
import { BootstrapLocaleSync } from "@/components/layout/bootstrap-locale-sync";
import { I18nProvider, useI18n } from "@/lib/i18n/provider";
import type { BootstrapSnapshot } from "@/lib/client/use-bootstrap-snapshot";

let sharedSnapshot: BootstrapSnapshot | null = null;

vi.mock("@/lib/client/bootstrap-snapshot-provider", () => ({
  useSharedBootstrapSnapshot: () => sharedSnapshot,
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root;
let container: HTMLDivElement;
let observedLocale = "";

function LocaleProbe() {
  const { locale } = useI18n();
  useEffect(() => {
    observedLocale = locale;
  }, [locale]);
  return null;
}

function snapshot(defaultLocale: string): BootstrapSnapshot {
  return {
    user: null,
    app: {
      defaultLocale,
      defaultTextModel: "",
      defaultImageModel: "",
      defaultVideoModel: "",
    },
    providers: {},
    providerConnections: {},
  };
}

function Harness() {
  const [, setTick] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setTick((value) => value + 1)}>
        refresh
      </button>
      <BootstrapLocaleSync />
      <LocaleProbe />
    </>
  );
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  sharedSnapshot = snapshot("en");
  observedLocale = "";
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BootstrapLocaleSync", () => {
  it("applies a bootstrap locale change without reload", async () => {
    act(() => {
      root.render(
        <I18nProvider initialLocale="en" initialMessages={en}>
          <Harness />
        </I18nProvider>,
      );
    });
    expect(observedLocale).toBe("en");

    sharedSnapshot = snapshot("zh-CN");
    await act(async () => {
      container.querySelector("button")!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(observedLocale).toBe("zh-CN");
  });
});
