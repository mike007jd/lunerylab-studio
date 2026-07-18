/** @vitest-environment happy-dom */

import { act, createElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMotionReducedPreference } from "@/components/motion/motion-primitives";

const framerPreference = vi.hoisted(() => ({ reduced: false }));

vi.mock("framer-motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("framer-motion")>()),
  useReducedMotion: () => framerPreference.reduced,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button"> & {
    variant?: string;
    size?: string;
  }) => {
    const buttonProps = { ...props };
    delete buttonProps.variant;
    delete buttonProps.size;
    return createElement("button", buttonProps, children);
  },
}));

vi.mock("@/components/ui/icons", () => ({
  Globe: (props: React.ComponentProps<"svg">) => createElement("svg", props),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: (props: React.ComponentProps<"button">) => createElement("button", props),
}));

vi.mock("@/components/motion/route-transition-provider", () => ({
  useRouteTransition: () => ({ activePathname: "/studio" }),
}));

vi.mock("@/lib/i18n/provider", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string) => key,
  }),
}));

import { TopHeader } from "@/components/layout/top-header";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function PreferenceProbe() {
  const reduced = useMotionReducedPreference();
  return createElement(
    "span",
    { "data-reduced": reduced ? "true" : "false" },
    reduced ? "reduced" : "not-reduced",
  );
}

function mockReducedMotionPreference() {
  const mediaQuery = {
    matches: true,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } satisfies MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));
}

afterEach(() => {
  framerPreference.reduced = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("useMotionReducedPreference", () => {
  it("uses a hydration-stable non-reduced server snapshot", () => {
    expect(renderToString(createElement(PreferenceProbe))).toContain("not-reduced");
  });

  it("matches the server marker on the first client render before applying reduced motion", async () => {
    mockReducedMotionPreference();
    const serverMarkup = renderToString(createElement(PreferenceProbe));
    const container = document.createElement("div");
    container.innerHTML = serverMarkup;
    document.body.append(container);
    const hydrationErrors: unknown[][] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
      hydrationErrors.push(args);
    });
    let root: Root | undefined;

    await act(async () => {
      root = hydrateRoot(container, createElement(PreferenceProbe));
    });

    expect(serverMarkup).toContain('data-reduced="false"');
    expect(hydrationErrors).toEqual([]);
    expect(container.firstElementChild?.getAttribute("data-reduced")).toBe("true");
    consoleError.mockRestore();
    await act(async () => root?.unmount());
  });

  it("hydrates TopHeader without reduced-motion attribute drift", async () => {
    mockReducedMotionPreference();
    framerPreference.reduced = false;
    const serverMarkup = renderToString(createElement(TopHeader));
    framerPreference.reduced = true;
    const container = document.createElement("div");
    container.innerHTML = serverMarkup;
    document.body.append(container);
    const hydrationErrors: unknown[][] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
      if (args.some((arg) => String(arg).includes("hydrated"))) hydrationErrors.push(args);
    });
    let root: Root | undefined;

    await act(async () => {
      root = hydrateRoot(container, createElement(TopHeader));
    });

    expect(hydrationErrors).toEqual([]);
    consoleError.mockRestore();
    await act(async () => root?.unmount());
  });
});
