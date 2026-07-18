import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SAMPLE_PROJECTS } from "@/lib/sample-data";

describe("bundled sample data", () => {
  it("keeps every declared sample image in the packaged public tree", async () => {
    const sources = SAMPLE_PROJECTS.flatMap((project) =>
      project.layers.map((layer) => layer.source),
    );

    expect(sources.length).toBeGreaterThan(0);
    await expect(
      Promise.all(sources.map((source) => access(path.join(process.cwd(), "public", source)))),
    ).resolves.toHaveLength(sources.length);
  });
});
