const INTERACTIVE_TARGET_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='slider']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
].join(",");

export function shouldDeleteSelectedCanvasLayer({
  key,
  target,
  tool,
  selectedLayer,
}: {
  key: string;
  target: EventTarget | null;
  tool: "select" | "mask";
  selectedLayer: { id: string; locked?: boolean } | null;
}): boolean {
  if (key !== "Backspace" && key !== "Delete") return false;
  if (tool !== "select" || !selectedLayer || selectedLayer.locked) return false;
  if (
    target instanceof HTMLElement &&
    target.closest(INTERACTIVE_TARGET_SELECTOR)
  ) {
    return false;
  }
  return true;
}
