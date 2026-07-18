import { describe, expect, it, vi } from "vitest";
import { removeProviderCredentials } from "@/components/settings/desktop-runtime/utils";
import type { DesktopInvoke } from "@/components/settings/desktop-runtime/types";

describe("provider credential removal ordering", () => {
  it("does not delete canonical metadata when the secret bridge is unavailable", async () => {
    const fetcher = vi.fn();

    await expect(
      removeProviderCredentials({ providerId: "openai", invoke: null, fetcher }),
    ).resolves.toEqual({ ok: false, secretRemoved: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not delete canonical metadata when secret deletion fails", async () => {
    const fetcher = vi.fn();
    const invoke: DesktopInvoke = async () => {
      throw new Error("keychain unavailable");
    };

    await expect(
      removeProviderCredentials({ providerId: "openai", invoke, fetcher }),
    ).resolves.toEqual({ ok: false, secretRemoved: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports partial removal when metadata deletion fails after the secret is gone", async () => {
    const invoke: DesktopInvoke = async <T,>() => ({} as T);
    const fetcher = vi.fn(async () => new Response(null, { status: 500 }));

    await expect(
      removeProviderCredentials({ providerId: "openai", invoke, fetcher }),
    ).resolves.toEqual({ ok: false, secretRemoved: true });
  });

  it("deletes metadata only after secret deletion succeeds", async () => {
    const order: string[] = [];
    const invoke: DesktopInvoke = async <T,>() => {
      order.push("secret");
      return {} as T;
    };
    const fetcher = vi.fn(async () => {
      order.push("metadata");
      return new Response(null, { status: 200 });
    });

    await expect(
      removeProviderCredentials({ providerId: "openai", invoke, fetcher }),
    ).resolves.toEqual({ ok: true });
    expect(order).toEqual(["secret", "metadata"]);
  });
});
