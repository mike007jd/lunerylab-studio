import { describe, expect, it } from "vitest";

import { getPlainT } from "@/lib/i18n/plain";
import type { Locale } from "@/lib/i18n/locale";
import { formatProjectTemplateContents } from "@/lib/project-template-content";

describe("project template content counts", () => {
  it.each([
    [0, 0, "0 assets · 0 canvases"],
    [1, 1, "1 asset · 1 canvas"],
    [2, 3, "2 assets · 3 canvases"],
  ])("formats English counts for %i assets and %i canvases", (assets, canvases, expected) => {
    expect(formatProjectTemplateContents(getPlainT("en"), assets, canvases)).toBe(expected);
  });

  it.each([
    ["zh-CN", ["0 个素材 · 0 个画布", "1 个素材 · 1 个画布", "2 个素材 · 3 个画布"]],
    ["zh-TW", ["0 個素材 · 0 個畫布", "1 個素材 · 1 個畫布", "2 個素材 · 3 個畫布"]],
  ] satisfies Array<[Locale, string[]]>)("keeps natural count copy in %s", (locale, expected) => {
    const t = getPlainT(locale);
    expect(formatProjectTemplateContents(t, 0, 0)).toBe(expected[0]);
    expect(formatProjectTemplateContents(t, 1, 1)).toBe(expected[1]);
    expect(formatProjectTemplateContents(t, 2, 3)).toBe(expected[2]);
  });
});
