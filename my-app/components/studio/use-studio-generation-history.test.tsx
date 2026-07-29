// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  GenerationActivityRegistryProvider,
  useGenerationActivityRegistry,
  type GenerationActivityRegistry,
} from "@/components/studio/controllers/generation-activity-registry";
import {
  StudioGenerationHistoryProvider,
  useStudioGenerationHistory,
  type UseStudioGenerationHistoryResult,
} from "@/components/studio/use-studio-generation-history";

describe("Studio session-only generation history", () => {
  it("does not export a localStorage persistence key in the current contract", async () => {
    const historyModule = await import("@/components/studio/use-studio-generation-history");
    expect("STUDIO_HISTORY_STORAGE_KEY" in historyModule).toBe(false);
    expect("loadStudioHistoryEntries" in historyModule).toBe(false);
  });
});

describe("StudioGenerationHistoryProvider lifetime", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
  });

  it("preserves in-progress entries across Studio route unmount/remount", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    let latest: UseStudioGenerationHistoryResult | null = null;
    let latestRegistry: GenerationActivityRegistry | null = null;
    function Route() {
      latest = useStudioGenerationHistory();
      latestRegistry = useGenerationActivityRegistry().registry;
      return null;
    }
    function Shell({ showRoute }: { showRoute: boolean }) {
      return (
        <StudioGenerationHistoryProvider>
          <GenerationActivityRegistryProvider>
            {showRoute ? <Route /> : null}
          </GenerationActivityRegistryProvider>
        </StudioGenerationHistoryProvider>
      );
    }

    act(() => {
      root!.render(<Shell showRoute />);
    });

    let runningId = "";
    act(() => {
      runningId = latest!.add({
        mode: "image",
        prompt: "owned by shell",
        modelId: "local-image",
        aspectRatio: "1:1",
        count: 1,
        presetId: null,
        projectId: null,
        referenceAssetIds: [],
        batchVariants: null,
        generationParameters: {},
        videoDuration: null,
      });
    });
    expect(latest!.entries).toHaveLength(1);
    expect(latest!.entries[0]?.status).toBe("running");

    const requestController = new AbortController();
    const pollController = new AbortController();
    act(() => {
      latestRegistry!.begin({
        entryId: runningId,
        runId: "run-1",
        mode: "image",
        requestController,
        pollController,
      });
    });

    // Leave /studio while the console-shell provider stays mounted.
    act(() => {
      root!.render(<Shell showRoute={false} />);
    });
    expect(requestController.signal.aborted).toBe(false);
    expect(pollController.signal.aborted).toBe(false);
    expect(latestRegistry!.isCurrent(runningId, "run-1")).toBe(true);

    // Return to /studio — history must still hold the in-progress card.
    act(() => {
      root!.render(<Shell showRoute />);
    });

    expect(latest!.entries).toHaveLength(1);
    expect(latest!.entries[0]?.id).toBe(runningId);
    expect(latest!.entries[0]?.status).toBe("running");
    expect(latest!.entries[0]?.prompt).toBe("owned by shell");
    expect(latestRegistry!.isCurrent(runningId, "run-1")).toBe(true);
  });
});
