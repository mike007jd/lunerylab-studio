import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CanvasExportPopover } from "@/components/canvas/canvas-export-popover";
import { COPY } from "@/components/canvas/canvas-copy";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("CanvasExportPopover", () => {
  it("disables export on an empty canvas with an actionable accessible label", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(CanvasExportPopover, {
        disabled: true,
        busy: false,
        isChinese: false,
        copy: COPY.en,
        onExportOriginal: vi.fn(),
        onExportPlatforms: vi.fn(),
      }),
    ));

    expect(markup).toContain("disabled");
    expect(markup).toContain("Add at least one visible layer before exporting.");
  });
});
