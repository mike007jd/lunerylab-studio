import { describe, expect, it } from "vitest";
import { HttpError } from "./fetch-json";
import { toActionableGenerationError } from "./generation-errors";

const copy: Record<string, string> = {
  "studio.generationErrors.outOfMemory": "Lower the size or image count, or use a smaller model.",
  "studio.generationErrors.genericGuide": "Try again. If it continues, restart Local AI.",
};
const t = (key: string) => copy[key] ?? key;

describe("toActionableGenerationError", () => {
  it("maps a stable engine code to actionable copy", () => {
    const error = new HttpError("raw stderr (502)", {
      status: 502,
      statusText: "Bad Gateway",
      payload: { code: "local_sd_out_of_memory", message: "CUDA out of memory" },
    });

    expect(toActionableGenerationError(error, "Failed", t)).toBe(copy["studio.generationErrors.outOfMemory"]);
  });

  it("keeps unknown engine detail and appends general guidance", () => {
    const error = new HttpError("wrapped", {
      status: 502,
      statusText: "Bad Gateway",
      payload: { code: "local_sd_unknown", message: "sampler exploded at step 4" },
    });

    expect(toActionableGenerationError(error, "Failed", t)).toBe(
      "sampler exploded at step 4 Try again. If it continues, restart Local AI.",
    );
  });
});
