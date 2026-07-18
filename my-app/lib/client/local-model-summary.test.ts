import { describe, expect, it } from "vitest";
import {
  firstDiscoveredExternalTextModel,
  isLocalModelSummaryChecking,
  isTextCapabilityReady,
} from "@/hooks/use-local-model-summary";

describe("external local text model readiness", () => {
  it("uses the first exact model discovered from Ollama or LM Studio", () => {
    expect(
      firstDiscoveredExternalTextModel([
        { reachable: true, models: [] },
        { reachable: true, models: ["  local-text-model  ", "other-model"] },
      ]),
    ).toBe("local-text-model");
  });

  it("stays empty when reachable runtimes expose no model", () => {
    expect(firstDiscoveredExternalTextModel([{ reachable: true, models: [] }, null])).toBeNull();
  });

  it("ignores stale model lists from an unreachable runtime", () => {
    expect(
      firstDiscoveredExternalTextModel([
        { reachable: false, models: ["stale-model"] },
        null,
      ]),
    ).toBeNull();
  });
});

describe("local model summary loading truth", () => {
  it("stays checking until desktop availability and the first model probe settle", () => {
    expect(isLocalModelSummaryChecking(null, false)).toBe(true);
    expect(isLocalModelSummaryChecking(true, false)).toBe(true);
    expect(isLocalModelSummaryChecking(true, true)).toBe(false);
  });

  it("does not describe a confirmed unavailable desktop as still checking", () => {
    expect(isLocalModelSummaryChecking(false, false)).toBe(false);
  });
});

describe("text capability readiness", () => {
  it("does not call an installed model ready while its embedded engine is stopped", () => {
    expect(isTextCapabilityReady({
      llamaModel: "Local text model",
      mlxModel: null,
      externalTextModel: null,
      llamaRunning: false,
      mlxRunning: false,
    })).toBe(false);
  });

  it("accepts a running embedded model or a reachable external model", () => {
    expect(isTextCapabilityReady({
      llamaModel: "Local text model",
      mlxModel: null,
      externalTextModel: null,
      llamaRunning: true,
      mlxRunning: false,
    })).toBe(true);
    expect(isTextCapabilityReady({
      llamaModel: null,
      mlxModel: null,
      externalTextModel: "ollama-model",
      llamaRunning: false,
      mlxRunning: false,
    })).toBe(true);
  });
});
