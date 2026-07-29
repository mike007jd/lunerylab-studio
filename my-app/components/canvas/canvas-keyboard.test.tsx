// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { shouldDeleteSelectedCanvasLayer } from "@/components/canvas/canvas-keyboard";
import type { KonvaLayerItem } from "@/components/canvas/konva-stage";

function layer(overrides: Partial<KonvaLayerItem> = {}): KonvaLayerItem {
  return {
    id: "layer-1",
    assetId: "asset-1",
    assetUrl: "/asset.png",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 1,
    ...overrides,
  };
}

describe("canvas global delete shortcut", () => {
  it("allows body Delete only for an unlocked selected layer in select mode", () => {
    expect(
      shouldDeleteSelectedCanvasLayer({
        key: "Delete",
        target: document.body,
        tool: "select",
        selectedLayer: layer(),
      }),
    ).toBe(true);
    expect(
      shouldDeleteSelectedCanvasLayer({
        key: "Delete",
        target: document.body,
        tool: "select",
        selectedLayer: layer({ locked: true }),
      }),
    ).toBe(false);
  });

  it("never deletes while a form, link, or toolbar control owns the key event", () => {
    for (const element of [
      document.createElement("input"),
      document.createElement("textarea"),
      document.createElement("select"),
      document.createElement("button"),
      Object.assign(document.createElement("a"), { href: "/settings" }),
    ]) {
      expect(
        shouldDeleteSelectedCanvasLayer({
          key: "Backspace",
          target: element,
          tool: "select",
          selectedLayer: layer(),
        }),
      ).toBe(false);
    }

    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.appendChild(icon);
    expect(
      shouldDeleteSelectedCanvasLayer({
        key: "Delete",
        target: icon,
        tool: "select",
        selectedLayer: layer(),
      }),
    ).toBe(false);
  });
});
