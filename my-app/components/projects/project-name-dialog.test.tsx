// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectNameDialog } from "@/components/projects/project-name-dialog";
import { PROJECT_NAME_MAX_LENGTH } from "@/lib/project-name";

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

function renderDialog(name: string, onSubmit = vi.fn()) {
  act(() => {
    root.render(
      <ProjectNameDialog
        open
        name={name}
        title="Project name"
        description="Name this project"
        inputLabel="Project name"
        submitLabel="Save"
        cancelLabel="Cancel"
        onNameChange={() => {}}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
  });
  return onSubmit;
}

describe("ProjectNameDialog", () => {
  it("enforces the shared name limit and disables blank submission", () => {
    renderDialog("   ");
    const input = document.body.querySelector("input")!;
    const submit = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!;

    expect(input.maxLength).toBe(PROJECT_NAME_MAX_LENGTH);
    expect(input.labels?.[0]?.textContent).toBe("Project name");
    expect(submit.disabled).toBe(true);
  });

  it("submits the trimmed name", () => {
    const onSubmit = renderDialog("  Campaign  ");
    const form = document.body.querySelector("form")!;
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

    expect(onSubmit).toHaveBeenCalledWith("Campaign");
  });

  it("closes on cancel without submitting", () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    act(() => {
      root.render(
        <ProjectNameDialog
          open
          name="Campaign"
          title="Project name"
          description="Name this project"
          inputLabel="Project name"
          submitLabel="Save"
          cancelLabel="Cancel"
          onNameChange={() => {}}
          onOpenChange={onOpenChange}
          onSubmit={onSubmit}
        />,
      );
    });

    const cancel = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    )!;
    act(() => cancel.click());

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("collapses synchronous duplicate submissions into one request", async () => {
    let finishSubmit: (() => void) | undefined;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => {
      finishSubmit = resolve;
    }));
    renderDialog("Campaign", onSubmit);
    const form = document.body.querySelector("form")!;

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => finishSubmit?.());
  });
});
