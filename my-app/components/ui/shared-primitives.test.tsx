// @vitest-environment happy-dom
//
// happy-dom, not jsdom: jsdom 29 reaches into undici 7 internals, and this repo
// pins the patched undici 6.27.0 in pnpm-workspace.yaml.

/**
 * Regression cover for the three shared primitives with the widest blast radius
 * (Button and AssetImage are used across every surface; SelectTrigger across
 * every form). Each test pins one design invariant from
 * `docs/UI_FRAMEWORK_STACK.md` so a future edit to these primitives cannot
 * silently reintroduce the drift they were converged out of.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AssetImage } from "@/components/ui/asset-image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

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

function render(ui: React.ReactNode) {
  act(() => root.render(ui));
}

/**
 * Which icon-padding overrides a size variant actually applies to this button.
 *
 * The class string alone can't answer that — `has-[…]:px-*` is conditional on
 * the DOM — and happy-dom's `:has()` is unreliable (it reports a match for a
 * selector whose target does not exist). So we evaluate each `has-[…]:px-*`
 * variant's selector against the real tree with plain queries. An icon padding
 * that fires only while loading means the border box shrank: exactly the drift
 * INV-DD-05 forbids.
 */
function activeIconPaddings(button: HTMLButtonElement): string[] {
  const active: string[] = [];
  for (const token of button.className.split(/\s+/)) {
    const match = token.match(/^has-\[((?:[^[\]]|\[[^\]]*\])*)\]:(px-[\d.]+)$/);
    if (!match) continue;
    const selector = match[1] ?? "";
    const padding = match[2] ?? "";
    const fires =
      selector === ">svg"
        ? [...button.children].some((child) => child.tagName.toLowerCase() === "svg")
        : selector === "[data-slot=button-content]_svg"
          ? button.querySelector('[data-slot="button-content"] svg') !== null
          : // Any other selector (e.g. a bare `has-[svg]`) matches every
            // descendant svg — including the loading overlay's spinner.
            button.querySelector("svg") !== null;
    if (fires) active.push(padding);
  }
  return active.sort();
}

describe("Button loading (INV-DD-05)", () => {
  it("does not apply icon padding to a text-only button while it loads", () => {
    render(<Button>Save</Button>);
    const idle = activeIconPaddings(container.querySelector("button")!);

    render(<Button loading>Save</Button>);
    const busy = activeIconPaddings(container.querySelector("button")!);

    // The overlay spinner is an svg; it must not count as the caller's icon.
    expect(idle).toEqual([]);
    expect(busy).toEqual([]);
  });

  it("keeps the caller's icon padding applied while it loads", () => {
    render(
      <Button>
        <svg />
        Save
      </Button>,
    );
    const idle = activeIconPaddings(container.querySelector("button")!);

    render(
      <Button loading>
        <svg />
        Save
      </Button>,
    );
    const busy = activeIconPaddings(container.querySelector("button")!);

    expect(idle.length).toBeGreaterThan(0);
    expect(busy).toEqual(idle);
  });

  it("keeps the same padding classes whether or not it is loading", () => {
    render(<Button>Save</Button>);
    const idle = container.querySelector("button")!.className;

    render(<Button loading>Save</Button>);
    const busy = container.querySelector("button")!.className;

    expect(busy).toBe(idle);
  });

  it("keeps the children in the tree and overlays the spinner out of flow", () => {
    render(
      <Button loading>
        <svg data-testid="icon" />
        Save
      </Button>,
    );
    const button = container.querySelector("button")!;
    const content = button.querySelector('[data-slot="button-content"]')!;
    const spinner = button.querySelector('[data-slot="button-spinner"]')!;

    // Children keep their footprint: still rendered, hidden via inherited
    // visibility, and laid out by the button (display:contents), not removed.
    expect(content.textContent).toContain("Save");
    expect(content.querySelector('[data-testid="icon"]')).not.toBeNull();
    expect(content.className).toContain("contents");
    expect(content.className).toContain("invisible");

    // The spinner is an overlay, so it cannot add width and push adjacent chrome.
    expect(spinner.className).toContain("absolute");
    expect(spinner.parentElement).toBe(button);
    expect(spinner.contains(content)).toBe(false);
  });

  it("blocks interaction and announces the pending state while loading", () => {
    render(<Button loading>Save</Button>);
    const button = container.querySelector("button")!;

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("renders no spinner when idle", () => {
    render(<Button>Save</Button>);
    const button = container.querySelector("button")!;

    expect(button.querySelector('[data-slot="button-spinner"]')).toBeNull();
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.disabled).toBe(false);
  });
});

describe("form field radius grammar (INV-DD-07)", () => {
  it("gives SelectTrigger the same field radius as Input and Textarea", () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
      </Select>,
    );
    const trigger = container.querySelector('[data-slot="select-trigger"]')!;

    render(<Input />);
    const input = container.querySelector('[data-slot="input"]')!;

    render(<Textarea />);
    const textarea = container.querySelector('[data-slot="textarea"]')!;

    for (const field of [trigger, input, textarea]) {
      expect(field.className).toContain("rounded-xl");
      expect(field.className).not.toContain("rounded-md");
    }
  });
});

describe("AssetImage failure (INV-DD-02)", () => {
  it("renders a visible unavailable state when the stream fails without a caller fallback", () => {
    render(<AssetImage src="/api/assets/gone" alt="Generated design" />);
    const img = container.querySelector("img")!;

    act(() => {
      img.dispatchEvent(new Event("error", { bubbles: false }));
    });

    // No ghost: the <img> is gone and a labelled placeholder takes its place.
    expect(container.querySelector("img")).toBeNull();
    const unavailable = container.querySelector('[data-slot="asset-image-unavailable"]')!;
    expect(unavailable).not.toBeNull();
    expect(unavailable.getAttribute("aria-label")).toBe("Generated design");
    expect(unavailable.className).not.toContain("opacity-0");
  });

  it("prefers a caller fallback over the default unavailable state", () => {
    render(
      <AssetImage
        src="/api/assets/gone"
        alt="Generated design"
        fallback={<span data-testid="caller-fallback">gone</span>}
      />,
    );
    const img = container.querySelector("img")!;

    act(() => {
      img.dispatchEvent(new Event("error", { bubbles: false }));
    });

    expect(container.querySelector('[data-testid="caller-fallback"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="asset-image-unavailable"]')).toBeNull();
  });

  it("keeps the caller's classes on the failed placeholder so layout does not collapse", () => {
    render(
      <AssetImage
        src="/api/assets/gone"
        alt="Generated design"
        className="absolute inset-0 h-full w-full object-cover"
      />,
    );
    const img = container.querySelector("img")!;

    act(() => {
      img.dispatchEvent(new Event("error", { bubbles: false }));
    });

    const unavailable = container.querySelector('[data-slot="asset-image-unavailable"]')!;
    expect(unavailable.className).toContain("absolute inset-0 h-full w-full");
  });

  it("never leaves a loaded image stuck at opacity-0", () => {
    render(<AssetImage src="/api/assets/ok" alt="Generated design" />);
    const img = container.querySelector("img")!;

    act(() => {
      img.dispatchEvent(new Event("load", { bubbles: false }));
    });

    const loaded = container.querySelector("img")!;
    expect(loaded.className).toContain("opacity-100");
    expect(loaded.className).not.toContain("opacity-0");
  });
});
