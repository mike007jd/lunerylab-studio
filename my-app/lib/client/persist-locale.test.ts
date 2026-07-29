// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchJson = vi.fn();
const invalidateBootstrapSnapshot = vi.fn();

vi.mock("@/lib/client/fetch-json", () => ({
  fetchJson: (...args: unknown[]) => fetchJson(...args),
}));

vi.mock("@/lib/client/use-bootstrap-snapshot", () => ({
  invalidateBootstrapSnapshot: () => invalidateBootstrapSnapshot(),
}));

import { persistProfileLocale } from "@/lib/client/persist-locale";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("persistProfileLocale", () => {
  it("PATCHes the settings API and invalidates bootstrap on success", async () => {
    fetchJson.mockResolvedValue({ app: { defaultLocale: "zh-CN" } });

    await expect(persistProfileLocale("zh-CN")).resolves.toBe("zh-CN");

    expect(fetchJson).toHaveBeenCalledWith("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultLocale: "zh-CN" }),
    });
    expect(invalidateBootstrapSnapshot).toHaveBeenCalledOnce();
  });

  it("does not invalidate bootstrap when the PATCH fails", async () => {
    fetchJson.mockRejectedValue(new Error("save failed"));

    await expect(persistProfileLocale("en")).rejects.toThrow("save failed");
    expect(invalidateBootstrapSnapshot).not.toHaveBeenCalled();
  });
});
