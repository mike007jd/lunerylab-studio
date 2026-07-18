import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";

describe("Button default type", () => {
  it("defaults to a non-submitting button", () => {
    expect(renderToStaticMarkup(createElement(Button, null, "Open"))).toContain(
      'type="button"',
    );
  });

  it("preserves an explicit submit type", () => {
    expect(
      renderToStaticMarkup(createElement(Button, { type: "submit" }, "Save")),
    ).toContain('type="submit"');
  });
});
