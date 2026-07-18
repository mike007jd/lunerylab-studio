import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { COPY } from "@/components/canvas/canvas-copy";
import { createKeyedSingleFlight } from "@/lib/client/generation-presentation";
import en from "@/lib/i18n/messages/en";
import zhCN from "@/lib/i18n/messages/zh-CN";
import zhTW from "@/lib/i18n/messages/zh-TW";

const studioPageSource = readFileSync(
  new URL("../../components/studio/studio-page.tsx", import.meta.url),
  "utf8",
);
const studioOptionsSource = readFileSync(
  new URL("../../components/studio/studio-options-popover.tsx", import.meta.url),
  "utf8",
);
const canvasPageSource = readFileSync(
  new URL("../../components/canvas/canvas-page.tsx", import.meta.url),
  "utf8",
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Studio project creation guardrails", () => {
  it("rejects a same-frame duplicate before pending UI can render", async () => {
    const pending = deferred();
    const createProject = vi.fn(async () => pending.promise);
    const singleFlight = createKeyedSingleFlight();

    const first = singleFlight.run("create-project", createProject);
    const duplicate = singleFlight.run("create-project", createProject);

    expect(createProject).toHaveBeenCalledOnce();
    await expect(duplicate).resolves.toEqual({ started: false });

    pending.resolve();
    await expect(first).resolves.toEqual({ started: true, value: undefined });
  });

  it("wires project creation to single-flight, pending feedback, and the latest locale handler", () => {
    expect(studioPageSource).toContain(
      'projectCreateSingleFlight.run("create-project", async () =>',
    );
    expect(studioPageSource).toContain("setIsCreatingProject(true)");
    expect(studioPageSource).toContain("setIsCreatingProject(false)");
    expect(studioPageSource).toContain(
      "[addProjectToState, createProject, projectCreateSingleFlight, t]",
    );
    expect(studioPageSource).toMatch(
      /const handleCreateProjectVoid = useCallback\([\s\S]*?\[handleCreateProject\],\s*\);/,
    );
    expect(studioOptionsSource).toContain("loading={isCreating}");
    expect(studioOptionsSource).toContain("disabled={isCreating}");
  });
});

describe("localized deferred UI", () => {
  it("keeps the asset preview description translated in all supported locales", () => {
    expect(en.assetActions.previewDescription).toBe(
      "Preview this asset and choose an available action.",
    );
    expect(zhCN.assetActions.previewDescription).toBe("预览此作品并选择可用操作。");
    expect(zhTW.assetActions.previewDescription).toBe("預覽此作品並選擇可用操作。");
  });

  it("uses the active locale while the browser-only Canvas stage is loading", () => {
    expect(COPY.en.openingTitle).toBe("Opening canvas");
    expect(COPY["zh-CN"].openingTitle).toBe("正在打开画布");
    expect(COPY["zh-TW"].openingTitle).toBe("正在開啟畫布");
    expect(canvasPageSource).toMatch(
      /function CanvasStageLoading\(\)[\s\S]*?const \{ locale \} = useI18n\(\);[\s\S]*?const copy = COPY\[locale\] \?\? COPY\.en;/,
    );
    expect(canvasPageSource).toContain("loading: CanvasStageLoading");
  });
});
