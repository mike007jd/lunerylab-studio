import { describe, expect, it } from "vitest";
import en from "@/lib/i18n/messages/en";
import zhCN from "@/lib/i18n/messages/zh-CN";
import zhTW from "@/lib/i18n/messages/zh-TW";

describe("project deletion copy", () => {
  it("keeps every deletion key in all locale catalogs", () => {
    for (const catalog of [en, zhCN, zhTW]) {
      expect(catalog.library).toMatchObject({
        projectActions: expect.any(String),
        deleteProject: expect.any(String),
        deleteProjectConfirm: expect.any(String),
        deleteProjectFailed: expect.any(String),
        deletingProject: expect.any(String),
      });
    }
  });
});
