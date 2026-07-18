import { describe, expect, it } from "vitest";
import { MODEL_DETAILS } from "@/components/settings/local-models/copy";
import { selectQuickStartImageModels } from "@/components/settings/local-models/catalog-utils";
import type { HubModelEntry, InstallStatusMap } from "@/components/settings/local-models/types";
import type { HardwareInfo } from "@/lib/desktop-runtime";
import { HF_MODEL_REGISTRY } from "@/lib/hf-model-catalog";

const apple32: HardwareInfo = {
  arch: "arm64",
  ram_gb: 32,
  apple_silicon: true,
  gpu_vendor: "apple",
  gpu_accel: "metal",
  disk_available_gb: 200,
};

const imageEntries = (HF_MODEL_REGISTRY as readonly HubModelEntry[]).filter(
  (entry) => entry.capability === "image-gen",
);

describe("local model UI copy", () => {
  it("does not describe uninstalled compatibility rows as installed", () => {
    for (const locale of Object.values(MODEL_DETAILS)) {
      for (const details of Object.values(locale)) {
        expect(details.bestFor).not.toMatch(/Installed|已安装|已安裝/);
        expect(details.why).not.toMatch(/already installed|已经安装|已經安裝/);
      }
    }
  });
});

describe("selectQuickStartImageModels", () => {
  it("puts the fast small image path ahead of the 32GB flagship on first run", () => {
    const shortlist = selectQuickStartImageModels({
      entries: imageEntries,
      installStatuses: {},
      activeMlxModel: null,
      hw: apple32,
    });

    expect(shortlist.map((entry) => entry.id)).toEqual(["sd15-emaonly"]);
  });

  it("keeps installed image models first once the user has one ready", () => {
    const installStatuses: InstallStatusMap = {
      "flux2-dev-q4": {
        id: "flux2-dev-q4",
        fileName: "flux2-dev-Q4_K_M.gguf",
        installed: true,
        partial: false,
        installedFiles: 1,
        fileCount: 1,
        installedBytes: 34_543_173_108,
        totalBytes: 34_543_173_108,
        missingFiles: [],
      },
    };

    const shortlist = selectQuickStartImageModels({
      entries: imageEntries,
      installStatuses,
      activeMlxModel: null,
      hw: apple32,
    });

    expect(shortlist.map((entry) => entry.id)).toEqual(["flux2-dev-q4"]);
  });

  it("keeps multiple installed choices visible for returning users", () => {
    const installStatuses = Object.fromEntries(
      ["sd15-emaonly", "flux2-dev-q4"].map((id) => [
        id,
        {
          id,
          fileName: `${id}.gguf`,
          installed: true,
          partial: false,
          installedFiles: 1,
          fileCount: 1,
          installedBytes: 1,
          totalBytes: 1,
          missingFiles: [],
        },
      ]),
    ) satisfies InstallStatusMap;

    const shortlist = selectQuickStartImageModels({
      entries: imageEntries,
      installStatuses,
      activeMlxModel: null,
      hw: apple32,
    });

    expect(shortlist.map((entry) => entry.id)).toEqual(["flux2-dev-q4", "sd15-emaonly"]);
  });
});
