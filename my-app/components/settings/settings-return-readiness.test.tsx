// @vitest-environment happy-dom

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapSnapshot } from "@/lib/client/use-bootstrap-snapshot";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  fetchJson: vi.fn(),
  fetchInstallStatuses: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(
    "panel=text&capability=text&returnTo=%2Fcanvas%2Fproject-1",
  ),
}));
vi.mock("@/lib/client/use-model-catalog", () => ({
  useModelCatalog: () => ({
    imageModels: [],
    videoModels: [],
    loading: false,
    error: false,
  }),
}));
vi.mock("@/components/settings/local-models/catalog-utils", () => ({
  fetchInstallStatuses: mocks.fetchInstallStatuses,
}));
vi.mock("@/lib/client/fetch-json", () => ({
  fetchJson: mocks.fetchJson,
  toErrorMessage: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@/lib/i18n/provider", () => ({
  useI18n: () => ({ locale: "en", setLocale: vi.fn() }),
}));
vi.mock("@/lib/i18n/useT", () => ({ useT: () => (key: string) => key }));
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<"div"> & Record<string, unknown>) => {
      const elementProps = { ...props };
      delete elementProps.onAnimationComplete;
      delete elementProps.initial;
      delete elementProps.animate;
      delete elementProps.transition;
      return <div {...elementProps}>{children}</div>;
    },
  },
}));
vi.mock("@/components/motion/motion-primitives", () => ({
  HoverLiftCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PageReveal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useMotionReducedPreference: () => true,
}));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsContent: ({ children, hidden }: { children: ReactNode; hidden?: boolean }) => <div hidden={hidden}>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("@/components/ui/icons", () => ({
  Activity: () => <span />,
  Bot: () => <span />,
  Check: () => <span />,
  ChevronDown: () => <span />,
  ChevronUp: () => <span />,
  Film: () => <span />,
  ImageIcon: () => <span />,
  Settings: () => <span />,
}));
vi.mock("@/components/settings/local-models-panel", () => ({ LocalModelsPanel: () => null }));
vi.mock("@/components/settings/desktop-runtime-card", () => ({ DesktopRuntimeCard: () => null }));
vi.mock("@/components/settings/runtime-health-panel", () => ({ RuntimeHealthPanel: () => null }));
vi.mock("@/components/settings/settings-default-model-card", () => ({ SettingsDefaultModelCard: () => null }));
vi.mock("@/components/settings/settings-language-card", () => ({ SettingsLanguageCard: () => null }));
vi.mock("@/components/settings/workspace-data-panel", () => ({ WorkspaceDataPanel: () => null }));

import { SettingsPage } from "@/components/settings/settings-page";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root;
let container: HTMLDivElement;

function bootstrap(defaultTextModel: string): BootstrapSnapshot {
  return {
    user: null,
    app: {
      defaultLocale: "en",
      defaultTextModel,
      defaultImageModel: "",
      defaultVideoModel: "",
    },
    providers: {},
    providerConnections: {},
  };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.fetchInstallStatuses.mockResolvedValue({
    installed: {
      id: "installed",
      label: "Installed",
      capability: "planner-llm",
      installed: true,
      partial: false,
      installedFiles: 1,
      fileCount: 1,
      installedBytes: 1,
      totalBytes: 1,
      missingFiles: [],
    },
  });
  mocks.fetchJson.mockResolvedValue({ app: bootstrap("").app, providers: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Settings returnTo readiness", () => {
  it("keeps a stale local default on Settings and lets the user clear it", async () => {
    await act(async () => {
      root.render(<SettingsPage initialData={bootstrap("local:removed")} />);
      await Promise.resolve();
    });

    expect(mocks.replace).not.toHaveBeenCalledWith("/canvas/project-1");
    expect(container.textContent).toContain("settings.defaultModelUnavailable");
    const clear = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "settings.clearDefaultModel",
    );
    expect(clear).toBeTruthy();

    await act(async () => {
      clear!.click();
      await Promise.resolve();
    });

    expect(mocks.fetchJson).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({ body: JSON.stringify({ defaultTextModel: "" }) }),
    );
    expect(mocks.replace).not.toHaveBeenCalledWith("/canvas/project-1");
  });
});
