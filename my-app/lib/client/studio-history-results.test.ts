import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  STUDIO_HISTORY_LIMIT,
  prependStudioHistoryEntry,
  type GenerationEntry,
} from "@/components/studio/use-studio-generation-history";
import {
  GenerationResultsGrid,
  RECENT_RESULTS_LIMIT,
  partitionGenerationResults,
} from "@/components/studio/generation-results-grid";
import { I18nProvider } from "@/lib/i18n/provider";
import en from "@/lib/i18n/messages/en";
import { getPlainT } from "@/lib/i18n/plain";
import type { Locale } from "@/lib/i18n/locale";

function entry(id: string): GenerationEntry {
  return {
    id,
    mode: "image",
    status: "succeeded",
    prompt: id,
    modelId: "test-model",
    aspectRatio: "1:1",
    count: 1,
    presetId: null,
    projectId: null,
    referenceAssetIds: [],
    batchVariants: null,
    assets: [],
    warnings: [],
    error: null,
    createdAt: 0,
  };
}

function renderInEnglish(content: ReactElement): string {
  const providerProps = {
    initialLocale: "en" as const,
    initialMessages: en,
    children: content,
  };
  return renderToStaticMarkup(createElement(I18nProvider, providerProps));
}

describe("Studio history efficiency", () => {
  it("keeps runtime history at the same strict limit as persistence", () => {
    const existing = Array.from(
      { length: STUDIO_HISTORY_LIMIT },
      (_, index) => entry(`existing-${index}`),
    );

    const next = prependStudioHistoryEntry(existing, entry("newest"));

    expect(next).toHaveLength(STUDIO_HISTORY_LIMIT);
    expect(next[0]?.id).toBe("newest");
    expect(next.some((item) => item.id === `existing-${STUDIO_HISTORY_LIMIT - 1}`)).toBe(false);
  });

  it("mounts only 12 recent batches until earlier results are expanded", () => {
    const entries = Array.from(
      { length: RECENT_RESULTS_LIMIT + 1 },
      (_, index) => entry(`entry-${index}`),
    );

    const collapsed = partitionGenerationResults(entries, false);
    const expanded = partitionGenerationResults(entries, true);

    expect(collapsed.visibleEntries).toHaveLength(RECENT_RESULTS_LIMIT);
    expect(collapsed.earlierCount).toBe(1);
    expect(collapsed.visibleEntries.at(-1)?.id).toBe(`entry-${RECENT_RESULTS_LIMIT - 1}`);
    expect(expanded.visibleEntries).toHaveLength(RECENT_RESULTS_LIMIT + 1);
    expect(expanded.earlierCount).toBe(1);
  });

  it("renders a discoverable earlier-results control and keeps Library available", () => {
    const entries = Array.from(
      { length: RECENT_RESULTS_LIMIT + 1 },
      (_, index) => ({
        ...entry(`entry-${index}`),
        status: "failed" as const,
        error: "Test failure",
      }),
    );
    const noop = () => {};
    const content = createElement(GenerationResultsGrid, {
      entries,
      onRegenerate: noop,
      onSendToCanvas: noop,
      onDismiss: noop,
    });
    const providerProps = {
      initialLocale: "en" as const,
      initialMessages: en,
      children: content,
    };
    const markup = renderToStaticMarkup(
      createElement(I18nProvider, providerProps),
    );

    expect(markup.match(/<article/g)).toHaveLength(RECENT_RESULTS_LIMIT);
    expect(markup).toContain("Earlier results");
    expect(markup).toContain('href="/library"');
  });

  it.each(["en", "zh-CN", "zh-TW"] satisfies Locale[])(
    "localizes earlier-results disclosure for %s",
    (locale) => {
      const t = getPlainT(locale);
      expect(t("studio.earlierResults")).not.toBe("studio.earlierResults");
      expect(t("studio.earlierResultsSummary", { count: 2 })).toContain("2");
      expect(t("studio.openLibrary")).not.toBe("studio.openLibrary");
    },
  );

  it("renders real sampling progress with an accessible cancel action", () => {
    const running = { ...entry("running-1"), status: "running" as const, count: 2 };
    const content = createElement(GenerationResultsGrid, {
      entries: [running],
      onRegenerate: () => {},
      onSendToCanvas: () => {},
      onDismiss: () => {},
      onCancel: () => {},
      progressByEntry: {
        "running-1": {
          runId: "run-1",
          phase: "sampling" as const,
          currentImage: 1,
          totalImages: 2,
          step: 7,
          totalSteps: 28,
          secondsPerStep: 2,
          startedAtMs: 100,
          updatedAtMs: 200,
        },
      },
    });
    const markup = renderInEnglish(content);

    expect(markup).toContain("Image 1/2 · step 7/28 · 25%");
    expect(markup).toContain("about 2m remaining");
    expect(markup).toContain(">Cancel<");
    expect(markup.indexOf("Image 1/2 · step 7/28 · 25%")).toBeLessThan(
      markup.indexOf("aspect-ratio"),
    );
  });

  it("renders cancellation as a muted retryable state", () => {
    const content = createElement(GenerationResultsGrid, {
      entries: [{ ...entry("canceled-1"), status: "canceled" as const }],
      onRegenerate: () => {},
      onSendToCanvas: () => {},
      onDismiss: () => {},
    });
    const markup = renderInEnglish(content);

    expect(markup).toContain("Canceled");
    expect(markup).toContain("Retry");
    expect(markup).not.toContain("bg-destructive/5");
  });
});
