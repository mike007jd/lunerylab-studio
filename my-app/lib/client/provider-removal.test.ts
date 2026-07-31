import { describe, expect, it, vi } from "vitest";
import { removeProviderCredentials } from "@/components/settings/desktop-runtime/utils";
import type { DesktopInvoke } from "@/components/settings/desktop-runtime/types";

describe("provider credential removal ordering", () => {
  it("unlinks metadata when the secret bridge is unavailable", async () => {
    const order: string[] = [];
    const fetcher = vi.fn(async () => {
      order.push("metadata");
      return new Response(null, { status: 200 });
    });

    await expect(
      removeProviderCredentials({
        providerId: "openai",
        invoke: null,
        fetcher,
      }),
    ).resolves.toEqual({ status: "removed-with-residual-secret" });
    expect(order).toEqual(["metadata"]);
  });

  it("keeps the product unlinked and reports a residual when secret deletion fails", async () => {
    const order: string[] = [];
    const fetcher = vi.fn(async () => {
      order.push("metadata");
      return new Response(null, { status: 200 });
    });
    const invoke: DesktopInvoke = async () => {
      order.push("secret");
      throw new Error("keychain unavailable");
    };

    await expect(
      removeProviderCredentials({
        providerId: "openai",
        invoke,
        fetcher,
      }),
    ).resolves.toEqual({ status: "removed-with-residual-secret" });
    expect(order).toEqual(["metadata", "secret"]);
  });

  it("still attempts secret cleanup when metadata deletion fails", async () => {
    const invoke: DesktopInvoke = async <T,>() => ({} as T);
    const fetcher = vi.fn(async () => new Response(null, { status: 500 }));

    await expect(
      removeProviderCredentials({ providerId: "openai", invoke, fetcher }),
    ).resolves.toEqual({ status: "metadata-removal-failed", secretRemoved: true });
  });

  it("unlinks metadata before deleting the system credential", async () => {
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
      removeProviderCredentials({
        providerId: "openai",
        invoke,
        fetcher,
      }),
    ).resolves.toEqual({ status: "removed" });
    expect(order).toEqual(["metadata", "secret"]);
  });

  it("unlinks Lunery metadata for environment-backed providers without touching credentials", async () => {
    const secretCalls: string[] = [];
    const invoke: DesktopInvoke = async (command) => {
      secretCalls.push(command);
      throw new Error("environment credentials must not be deleted");
    };
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));

    await expect(
      removeProviderCredentials({
        providerId: "openai",
        invoke,
        fetcher,
        preserveEnvironmentSecret: true,
      }),
    ).resolves.toEqual({ status: "removed" });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/desktop-runtime/provider-connections",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(secretCalls).toEqual([]);
  });
});
