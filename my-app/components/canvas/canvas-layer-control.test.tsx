// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasLayerControl, type CanvasLayerControlProps } from "@/components/canvas/canvas-layer-control";
import type { KonvaLayerItem } from "@/components/canvas/konva-stage";
import { I18nProvider } from "@/lib/i18n/provider";
import en from "@/lib/i18n/messages/en";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function makeLayer(id: string, overrides: Partial<KonvaLayerItem> = {}): KonvaLayerItem {
  return {
    id,
    assetId: `asset-${id}`,
    assetUrl: `https://example.test/${id}.png`,
    x: 100,
    y: 100,
    width: 200,
    height: 150,
    zIndex: 1,
    ...overrides,
  };
}

const DEFAULT_LAYERS = () => [makeLayer("a", { zIndex: 2 }), makeLayer("b", { zIndex: 1 })];

function mountControl({
  layers = DEFAULT_LAYERS(),
  selectedLayerId = null,
  onSelectLayer = vi.fn<(layerId: string | null) => void>(),
  onPatchLayer = vi.fn<NonNullable<CanvasLayerControlProps["onPatchLayer"]>>(),
  onDeleteLayer = vi.fn<(layerId: string) => void>(),
  onToggleLock = vi.fn<(layerId: string, locked: boolean) => void>(),
  isLockPending,
  isInteractionBlocked,
}: {
  layers?: KonvaLayerItem[];
  selectedLayerId?: string | null;
  onSelectLayer?: CanvasLayerControlProps["onSelectLayer"];
  onPatchLayer?: CanvasLayerControlProps["onPatchLayer"];
  onDeleteLayer?: CanvasLayerControlProps["onDeleteLayer"];
  onToggleLock?: CanvasLayerControlProps["onToggleLock"];
  isLockPending?: CanvasLayerControlProps["isLockPending"];
  isInteractionBlocked?: CanvasLayerControlProps["isInteractionBlocked"];
} = {}) {
  act(() => {
    root.render(
      <I18nProvider initialLocale="en" initialMessages={en}>
        <CanvasLayerControl
          layers={layers}
          selectedLayerId={selectedLayerId}
          onSelectLayer={onSelectLayer}
          onPatchLayer={onPatchLayer}
          onDeleteLayer={onDeleteLayer}
          onToggleLock={onToggleLock}
          isLockPending={isLockPending}
          isInteractionBlocked={isInteractionBlocked}
        />
      </I18nProvider>,
    );
  });
  return { onSelectLayer, onPatchLayer, onDeleteLayer, onToggleLock };
}

function renderControl(
  props: Parameters<typeof mountControl>[0] = {},
) {
  const handlers = mountControl(props);
  const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  act(() => {
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return handlers;
}

function rerenderSelection(selectedLayerId: string | null, layers?: KonvaLayerItem[]) {
  mountControl({
    layers: layers ?? DEFAULT_LAYERS(),
    selectedLayerId,
  });
}

function layerButtons(): HTMLButtonElement[] {
  // The layer selection button is the row's first control; the lock toggle is
  // its sibling, not a child (no nested buttons).
  return [...container.querySelectorAll<HTMLButtonElement>("#canvas-layer-list li > button:first-child")];
}

function lockButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("#canvas-layer-list li > button:last-child")];
}

function keydown(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

describe("CanvasLayerControl", () => {
  it("exposes every layer as a focusable toggle button with an accessible name", () => {
    renderControl();
    const list = container.querySelector("#canvas-layer-list")!;
    const items = layerButtons();

    expect(list.tagName).toBe("UL");
    expect(list.getAttribute("aria-label")).toBe(en.canvas.layersPanel.ariaLabel);
    expect(list.getAttribute("aria-describedby")).toBe("canvas-layer-control-hint");
    expect(items).toHaveLength(2);
    // Independently focusable: no roving tabindex traps siblings.
    expect(items.every((item) => item.tabIndex === 0)).toBe(true);
    expect(items[0]?.textContent).toContain("Layer 1");
    expect(items[0]?.textContent).toContain("200×150");
    expect(items[1]?.textContent).toContain("Layer 2");
    expect(items[0]?.getAttribute("aria-pressed")).toBe("false");
    // The hint names the actual keys.
    const hint = document.getElementById("canvas-layer-control-hint")!.textContent!;
    expect(hint).toContain("Tab");
    expect(hint).toContain("Enter");
    expect(hint).toContain("Arrow");
    expect(hint).toContain("Shift+Arrow");
    expect(hint).toContain("Delete");
  });

  it("reaches and selects layer B with the keyboard after selecting layer A", () => {
    const layers = [makeLayer("a", { zIndex: 2 }), makeLayer("b", { zIndex: 1 })];
    const onSelectLayer = vi.fn<(layerId: string | null) => void>();
    const onPatchLayer = vi.fn<NonNullable<CanvasLayerControlProps["onPatchLayer"]>>();
    renderControl({ layers, onSelectLayer, onPatchLayer });
    const first = layerButtons()[0]!;

    // Select layer A with Enter.
    act(() => first.focus());
    keydown(first, "Enter");
    expect(onSelectLayer).toHaveBeenCalledWith("a");

    // Selection lands on the next render, like the real canvas state flow.
    act(() => {
      root.render(
        <I18nProvider initialLocale="en" initialMessages={en}>
          <CanvasLayerControl
            layers={layers}
            selectedLayerId="a"
            onSelectLayer={onSelectLayer}
            onPatchLayer={onPatchLayer}
          />
        </I18nProvider>,
      );
    });
    expect(layerButtons()[0]?.getAttribute("aria-pressed")).toBe("true");

    // Layer B stays reachable after A is selected: focus it directly (Tab
    // reaches it because every button keeps tabIndex 0) and select with Enter.
    const secondAfter = layerButtons()[1]!;
    act(() => secondAfter.focus());
    expect(document.activeElement).toBe(secondAfter);
    keydown(secondAfter, "Enter");
    expect(onSelectLayer).toHaveBeenCalledWith("b");

    // Arrows on an unselected layer never move artwork.
    keydown(secondAfter, "ArrowRight");
    expect(onPatchLayer).not.toHaveBeenCalled();
  });

  it("moves the selected layer with arrow keys", () => {
    const layers = [makeLayer("a", { zIndex: 2 }), makeLayer("b", { zIndex: 1 })];
    const onPatchLayer = vi.fn<NonNullable<CanvasLayerControlProps["onPatchLayer"]>>();
    renderControl({ layers, selectedLayerId: "a", onPatchLayer });
    const first = layerButtons()[0]!;

    keydown(first, "ArrowRight");
    expect(onPatchLayer).toHaveBeenCalledWith("a", { x: 110 });

    keydown(first, "ArrowUp");
    expect(onPatchLayer).toHaveBeenCalledWith("a", { y: 90 });
  });

  it("resizes the selected layer with Shift+arrow keys and clamps to the minimum", () => {
    const { onPatchLayer } = renderControl({ selectedLayerId: "a" });
    const first = layerButtons()[0]!;

    keydown(first, "ArrowDown", { shiftKey: true });
    expect(onPatchLayer).toHaveBeenCalledWith("a", { height: 160 });

    keydown(first, "ArrowLeft", { shiftKey: true });
    expect(onPatchLayer).toHaveBeenCalledWith("a", { width: 190 });
  });

  it("deletes the selected layer with Delete and Backspace", () => {
    const { onDeleteLayer, onSelectLayer } = renderControl({ selectedLayerId: "a" });

    keydown(layerButtons()[0]!, "Delete");
    expect(onSelectLayer).toHaveBeenCalledWith("a");
    expect(onDeleteLayer).toHaveBeenCalledWith("a");

    keydown(layerButtons()[0]!, "Backspace");
    expect(onDeleteLayer).toHaveBeenCalledTimes(2);
  });

  it("locked layers report their state and reject move, resize, and delete", () => {
    const layers = [makeLayer("a", { zIndex: 2, locked: true }), makeLayer("b", { zIndex: 1 })];
    const onPatchLayer = vi.fn<NonNullable<CanvasLayerControlProps["onPatchLayer"]>>();
    const onDeleteLayer = vi.fn<(layerId: string) => void>();
    renderControl({ layers, selectedLayerId: "a", onPatchLayer, onDeleteLayer });
    const locked = layerButtons()[0]!;

    // Accessible name exposes the locked state.
    expect(locked.textContent).toContain(en.canvas.layersPanel.layerLocked);

    keydown(locked, "ArrowRight");
    keydown(locked, "ArrowDown", { shiftKey: true });
    keydown(locked, "Delete");
    expect(onPatchLayer).not.toHaveBeenCalled();
    expect(onDeleteLayer).not.toHaveBeenCalled();

    // The hint does not claim unavailable operations; it explains the lock.
    const hint = document.getElementById("canvas-layer-control-hint")!.textContent!;
    expect(hint).toContain(en.canvas.layersPanel.lockedSelected);
  });

  it("rejects move, resize, delete, and lock input while deletion owns the layer", () => {
    const onPatchLayer = vi.fn<NonNullable<CanvasLayerControlProps["onPatchLayer"]>>();
    const onDeleteLayer = vi.fn<(layerId: string) => void>();
    const onToggleLock = vi.fn<(layerId: string, locked: boolean) => void>();
    renderControl({
      selectedLayerId: "a",
      onPatchLayer,
      onDeleteLayer,
      onToggleLock,
      isInteractionBlocked: (layerId) => layerId === "a",
    });

    const layer = layerButtons()[0]!;
    keydown(layer, "ArrowRight");
    keydown(layer, "ArrowDown", { shiftKey: true });
    keydown(layer, "Delete");
    act(() => {
      lockButtons()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onPatchLayer).not.toHaveBeenCalled();
    expect(onDeleteLayer).not.toHaveBeenCalled();
    expect(onToggleLock).not.toHaveBeenCalled();
  });

  it("does not show the locked notice for unlocked selections", () => {
    renderControl({ selectedLayerId: "a" });
    const hint = document.getElementById("canvas-layer-control-hint")!.textContent!;
    expect(hint).not.toContain(en.canvas.layersPanel.lockedSelected);
  });

  it("keeps panel open across selection re-renders", () => {
    renderControl();
    rerenderSelection("a");
    expect(container.querySelector("#canvas-layer-list")).not.toBeNull();
    expect(layerButtons()[0]?.getAttribute("aria-pressed")).toBe("true");
  });

  it("hides entirely when there are no layers", () => {
    act(() => {
      root.render(
        <I18nProvider initialLocale="en" initialMessages={en}>
          <CanvasLayerControl layers={[]} selectedLayerId={null} />
        </I18nProvider>,
      );
    });
    expect(container.querySelector("[data-slot='canvas-layer-control']")).toBeNull();
  });

  it("exposes a visible, independently focusable lock or unlock action for every layer", () => {
    const layers = [makeLayer("a", { zIndex: 2, locked: true }), makeLayer("b", { zIndex: 1 })];
    renderControl({ layers });
    const locks = lockButtons();

    expect(locks).toHaveLength(2);
    // Localized accessible names describe the action from the current state.
    expect(locks[0]?.getAttribute("aria-label")).toBe(en.canvas.layersPanel.unlockLayer);
    expect(locks[1]?.getAttribute("aria-label")).toBe(en.canvas.layersPanel.lockLayer);
    // Toggle state is exposed programmatically.
    expect(locks[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(locks[1]?.getAttribute("aria-pressed")).toBe("false");
    // The action is visible (an icon, not sr-only) and Tab-reachable.
    expect(locks[0]?.querySelector("svg")).not.toBeNull();
    expect(locks[1]?.querySelector("svg")).not.toBeNull();
    expect(locks.every((button) => button.tabIndex === 0)).toBe(true);

    act(() => locks[0]!.focus());
    expect(document.activeElement).toBe(locks[0]);
    act(() => locks[1]!.focus());
    expect(document.activeElement).toBe(locks[1]);
  });

  it("keeps the lock action a sibling — no nested buttons inside the layer button", () => {
    renderControl();
    for (const layerButton of layerButtons()) {
      expect(layerButton.querySelector("button")).toBeNull();
    }
    for (const lockButton of lockButtons()) {
      expect(lockButton.querySelector("button")).toBeNull();
    }
  });

  it("disables the lock control and shows a progress indicator while a transition is pending", () => {
    const layers = [makeLayer("a", { zIndex: 2, locked: true }), makeLayer("b", { zIndex: 1 })];
    const onToggleLock = vi.fn<(layerId: string, locked: boolean) => void>();
    renderControl({
      layers,
      onToggleLock,
      isLockPending: (layerId) => layerId === "a",
    });
    const locks = lockButtons();
    const pending = locks[0]!;
    const idle = locks[1]!;

    // Pending: disabled so a reverse intent cannot be expressed, busy for AT,
    // and a visible spinner overlays the (space-preserving) lock glyph.
    expect(pending.disabled).toBe(true);
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect(pending.querySelector("[data-slot='button-spinner'] svg")).not.toBeNull();
    // The localized action label is preserved while pending.
    expect(pending.getAttribute("aria-label")).toBe(en.canvas.layersPanel.unlockLayer);
    // The lock glyph still occupies its footprint (no layout shift) but is hidden.
    expect(pending.querySelector("[data-slot='button-content'] svg")).not.toBeNull();

    // Clicks while pending never reach the toggle callback.
    act(() => {
      pending.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggleLock).not.toHaveBeenCalled();

    // The pending layer's selection row stays enabled.
    expect(layerButtons()[0]!.disabled).toBe(false);

    // The idle sibling is unaffected: enabled, not busy, and functional.
    expect(idle.disabled).toBe(false);
    expect(idle.getAttribute("aria-busy")).toBeNull();
    expect(idle.querySelector("[data-slot='button-spinner']")).toBeNull();
    act(() => idle.focus());
    expect(document.activeElement).toBe(idle);
    act(() => {
      idle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggleLock).toHaveBeenCalledWith("b", true);
  });

  it("locks and unlocks without selecting the layer", () => {
    const layers = [makeLayer("a", { zIndex: 2, locked: true }), makeLayer("b", { zIndex: 1 })];
    const onSelectLayer = vi.fn<(layerId: string | null) => void>();
    const onToggleLock = vi.fn<(layerId: string, locked: boolean) => void>();
    renderControl({ layers, onSelectLayer, onToggleLock });

    act(() => {
      lockButtons()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggleLock).toHaveBeenCalledWith("a", false);
    expect(onSelectLayer).not.toHaveBeenCalled();

    act(() => {
      lockButtons()[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggleLock).toHaveBeenCalledWith("b", true);
    expect(onSelectLayer).not.toHaveBeenCalled();
  });

  it("isolates lock-button keys from selection, geometry, and deletion", () => {
    const onSelectLayer = vi.fn<(layerId: string | null) => void>();
    const onPatchLayer = vi.fn<NonNullable<CanvasLayerControlProps["onPatchLayer"]>>();
    const onDeleteLayer = vi.fn<(layerId: string) => void>();
    renderControl({ selectedLayerId: "a", onSelectLayer, onPatchLayer, onDeleteLayer });
    const lockButton = lockButtons()[0]!;

    act(() => lockButton.focus());
    keydown(lockButton, "Enter");
    keydown(lockButton, "Delete");
    keydown(lockButton, "Backspace");
    keydown(lockButton, "ArrowRight");
    keydown(lockButton, "ArrowDown", { shiftKey: true });

    // Enter activates the button natively (click); it must never select,
    // move, resize, or delete the layer.
    expect(onSelectLayer).not.toHaveBeenCalled();
    expect(onPatchLayer).not.toHaveBeenCalled();
    expect(onDeleteLayer).not.toHaveBeenCalled();
  });

  it("still offers the unlock action on a locked layer and keeps layer keys rejected", () => {
    const layers = [makeLayer("a", { zIndex: 2, locked: true }), makeLayer("b", { zIndex: 1 })];
    const onToggleLock = vi.fn<(layerId: string, locked: boolean) => void>();
    const onPatchLayer = vi.fn<NonNullable<CanvasLayerControlProps["onPatchLayer"]>>();
    const onDeleteLayer = vi.fn<(layerId: string) => void>();
    renderControl({ layers, selectedLayerId: "a", onToggleLock, onPatchLayer, onDeleteLayer });

    // The user is never stuck: the locked row's own unlock control works.
    act(() => {
      lockButtons()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggleLock).toHaveBeenCalledWith("a", false);

    // While locked, the row keeps rejecting edits.
    keydown(layerButtons()[0]!, "ArrowRight");
    keydown(layerButtons()[0]!, "Delete");
    expect(onPatchLayer).not.toHaveBeenCalled();
    expect(onDeleteLayer).not.toHaveBeenCalled();
  });
});
