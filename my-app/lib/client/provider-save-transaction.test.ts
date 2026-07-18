import { describe, expect, it, vi } from "vitest";
import { COPY } from "@/components/settings/desktop-runtime/constants";
import { saveProviderConnectionTransaction } from "@/components/settings/desktop-runtime/utils";
import type { DesktopInvoke } from "@/components/settings/desktop-runtime/types";

describe("provider save transaction", () => {
  it("rolls back a newly saved key when connection settings fail", async () => {
    const order: string[] = [];
    const invoke: DesktopInvoke = async <T,>(command: string) => {
      order.push(command);
      return {} as T;
    };

    await expect(
      saveProviderConnectionTransaction({
        providerId: "openai",
        apiKey: "new-key",
        hadSecret: false,
        invoke,
        saveConnection: async () => {
          order.push("save-connection");
          throw new Error("disk full");
        },
      }),
    ).resolves.toEqual({ status: "failed" });
    expect(order).toEqual([
      "save_provider_secret",
      "save-connection",
      "delete_provider_secret",
    ]);
  });

  it("reports partial success when a new key cannot be rolled back", async () => {
    const invoke: DesktopInvoke = async <T,>(command: string) => {
      if (command === "delete_provider_secret") throw new Error("keychain unavailable");
      return {} as T;
    };

    await expect(
      saveProviderConnectionTransaction({
        providerId: "openai",
        apiKey: "new-key",
        hadSecret: false,
        invoke,
        saveConnection: async () => {
          throw new Error("disk full");
        },
      }),
    ).resolves.toEqual({ status: "partial" });
  });

  it("keeps a replacement key when the prior write-only secret cannot be restored", async () => {
    const commands: string[] = [];
    const invoke: DesktopInvoke = async <T,>(command: string) => {
      commands.push(command);
      return {} as T;
    };

    await expect(
      saveProviderConnectionTransaction({
        providerId: "openai",
        apiKey: "replacement-key",
        hadSecret: true,
        invoke,
        saveConnection: async () => {
          throw new Error("disk full");
        },
      }),
    ).resolves.toEqual({ status: "partial" });
    expect(commands).toEqual(["save_provider_secret"]);
  });

  it("does not touch connection settings when key storage fails", async () => {
    const invoke: DesktopInvoke = async () => {
      throw new Error("keychain unavailable");
    };
    const saveConnection = vi.fn();

    await expect(
      saveProviderConnectionTransaction({
        providerId: "openai",
        apiKey: "new-key",
        hadSecret: false,
        invoke,
        saveConnection,
      }),
    ).resolves.toEqual({ status: "failed" });
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it("returns the canonical saved connection on success", async () => {
    const invoke: DesktopInvoke = async <T,>() => ({} as T);
    const connection = { endpoint: "https://api.openai.com/v1" };

    await expect(
      saveProviderConnectionTransaction({
        providerId: "openai",
        apiKey: "new-key",
        hadSecret: false,
        invoke,
        saveConnection: async () => connection,
      }),
    ).resolves.toEqual({ status: "saved", connection });
  });
});

describe("provider persistence feedback", () => {
  it.each(["en", "zh-CN", "zh-TW"] as const)(
    "keeps partial-save and removal errors distinct from desktop unavailability in %s",
    (locale) => {
      expect(COPY[locale].savePartial).not.toBe(COPY[locale].saveFailed);
      expect(COPY[locale].removeFailed).not.toBe(COPY[locale].unavailable);
    },
  );
});
