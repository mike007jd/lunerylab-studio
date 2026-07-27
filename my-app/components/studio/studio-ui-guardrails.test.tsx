import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CanvasStageLoading } from "@/components/canvas/canvas-stage-loading";
import { COPY } from "@/components/canvas/canvas-copy";
import { StudioLoadingShell } from "@/components/studio/studio-generation-surface";
import { I18nProvider } from "@/lib/i18n/provider";
import { createKeyedSingleFlight } from "@/lib/client/generation-presentation";
import en from "@/lib/i18n/messages/en";
import zhCN from "@/lib/i18n/messages/zh-CN";
import zhTW from "@/lib/i18n/messages/zh-TW";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderCanvasLoading(locale: "en" | "zh-CN" | "zh-TW") {
  const messages = locale === "en" ? en : locale === "zh-CN" ? zhCN : zhTW;
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale} initialMessages={messages}>
      <CanvasStageLoading />
    </I18nProvider>,
  );
}

describe("Studio rendered behavior guardrails", () => {
  it("rejects a same-frame duplicate project request", async () => {
    const pending = deferred();
    const createProject = vi.fn(async () => pending.promise);
    const singleFlight = createKeyedSingleFlight();

    const first = singleFlight.run("create-project", createProject);
    const duplicate = singleFlight.run("create-project", createProject);

    expect(createProject).toHaveBeenCalledOnce();
    await expect(duplicate).resolves.toEqual({ started: false });

    pending.resolve();
    await expect(first).resolves.toEqual({ started: true, value: undefined });
  });

  it("renders a visible, accessibility-labelled hydration shell", () => {
    const markup = renderToStaticMarkup(<StudioLoadingShell />);

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('data-slot="studio-loading-shell"');
    expect(markup).not.toContain("invisible");
  });
});

describe("localized deferred UI", () => {
  it("keeps the asset preview description translated in all supported locales", () => {
    expect(en.assetActions.previewDescription).toBe(
      "Preview this asset and choose an available action.",
    );
    expect(zhCN.assetActions.previewDescription).toBe("预览此作品并选择可用操作。");
    expect(zhTW.assetActions.previewDescription).toBe("預覽此作品並選擇可用操作。");
  });

  it("renders the Canvas loading state in the active locale", () => {
    expect(renderCanvasLoading("en")).toContain(COPY.en.openingTitle);
    expect(renderCanvasLoading("zh-CN")).toContain(COPY["zh-CN"].openingTitle);
    expect(renderCanvasLoading("zh-TW")).toContain(COPY["zh-TW"].openingTitle);
  });
});
