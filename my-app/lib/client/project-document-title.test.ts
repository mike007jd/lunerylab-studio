import { describe, expect, it } from "vitest";
import { buildProjectDocumentTitle } from "@/lib/client/project-document-title";

describe("buildProjectDocumentTitle", () => {
  it("uses the project name as the document title stem", () => {
    expect(buildProjectDocumentTitle("Launch Storyboard")).toBe(
      "Launch Storyboard — Lunery Lab Studio",
    );
  });

  it("does not invent a placeholder when the name is empty", () => {
    expect(buildProjectDocumentTitle("   ")).toBe("Lunery Lab Studio");
  });
});
