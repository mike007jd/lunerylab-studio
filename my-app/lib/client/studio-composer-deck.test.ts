import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ComposerDeck } from "@/components/studio/studio-composer-deck";

describe("Studio reference deck accessibility", () => {
  it("keeps keyboard reorder controls available at desktop breakpoints", () => {
    const noop = vi.fn();
    const markup = renderToStaticMarkup(createElement(ComposerDeck, {
      filePreviews: [
        {
          key: "first",
          file: { name: "first.png" } as File,
          url: "data:image/png;base64,iVBORw0KGgo=",
        },
        {
          key: "second",
          file: { name: "second.png" } as File,
          url: "data:image/png;base64,iVBORw0KGgo=",
        },
      ],
      draggingPreviewKey: null,
      dragOverPreviewKey: null,
      onOpenFilePicker: noop,
      onRemoveFile: noop,
      onMoveFile: noop,
      onDragStart: noop,
      onDragEnd: noop,
      onDragOver: noop,
      onDragLeave: noop,
      onDrop: noop,
      removeLabel: "Remove reference",
      addLabel: "Add reference",
      moveBeforeLabel: "Move reference earlier",
      moveAfterLabel: "Move reference later",
    }));

    expect(markup).toContain('aria-label="Move reference earlier: second.png"');
    expect(markup).toContain('aria-label="Move reference later: first.png"');
    expect(markup).not.toContain("md:hidden");
  });
});
