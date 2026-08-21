import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dnsMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  actualLookup: null as null | typeof import("node:dns/promises").lookup,
}));

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  dnsMocks.actualLookup = actual.lookup;
  dnsMocks.lookup.mockImplementation(actual.lookup);
  return {
    ...actual,
    lookup: (...args: Parameters<typeof actual.lookup>) => dnsMocks.lookup(...args),
  };
});

import { validateComfyEndpoint } from "@/lib/server/comfy-endpoint";

afterEach(() => {
  vi.unstubAllEnvs();
  if (dnsMocks.actualLookup) {
    dnsMocks.lookup.mockReset();
    dnsMocks.lookup.mockImplementation(dnsMocks.actualLookup);
  }
});

describe("validateComfyEndpoint trust boundary", () => {
  it("rejects endpoint URL credentials before resolving the host", async () => {
    await expect(
      validateComfyEndpoint("http://user:password@192.168.1.10:8188"),
    ).resolves.toEqual({
      error: "Endpoint must not include URL credentials.",
    });
  });

  it("rejects base URLs that contain a query or fragment", async () => {
    await expect(validateComfyEndpoint("http://127.0.0.1:8188/?x=1")).resolves.toEqual({
      error: "Endpoint must not include a query or fragment.",
    });
    await expect(validateComfyEndpoint("http://127.0.0.1:8188/#frag")).resolves.toEqual({
      error: "Endpoint must not include a query or fragment.",
    });
  });

  it("rejects non-http schemes and blocked metadata hosts", async () => {
    await expect(validateComfyEndpoint("ftp://127.0.0.1:8188")).resolves.toEqual({
      error: "Endpoint must use http or https.",
    });
    await expect(validateComfyEndpoint("http://metadata.google.internal")).resolves.toEqual({
      error: "Endpoint host is not allowed.",
    });
  });

  it("allows plain http for loopback and private-network addresses", async () => {
    // The homelab ComfyUI reality: LAN / Tailscale CGNAT / loopback over http.
    await expect(validateComfyEndpoint("http://127.0.0.1:8188")).resolves.toMatchObject({
      url: "http://127.0.0.1:8188/",
    });
    await expect(validateComfyEndpoint("http://192.168.1.143:8188")).resolves.toMatchObject({
      url: "http://192.168.1.143:8188/",
    });
    await expect(validateComfyEndpoint("http://100.120.182.80:8188")).resolves.toMatchObject({
      url: "http://100.120.182.80:8188/",
    });
  });

  it("allows https for public hosts and rejects http for them", async () => {
    await expect(validateComfyEndpoint("https://8.8.8.8")).resolves.toMatchObject({
      url: "https://8.8.8.8/",
    });
    await expect(validateComfyEndpoint("http://8.8.8.8:8188")).resolves.toEqual({
      error:
        "Endpoint must use https unless it points to this machine or a private network host.",
    });
  });

  it("rejects hostnames resolving to both public and private addresses", async () => {
    dnsMocks.lookup.mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
      { address: "192.168.1.10", family: 4 },
    ]);
    await expect(validateComfyEndpoint("http://comfy.example.test:8188")).resolves.toEqual({
      error: "Endpoint resolves to both public and private addresses.",
    });
  });

  it("rejects hostnames that do not resolve", async () => {
    dnsMocks.lookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(validateComfyEndpoint("http://nope.invalid:8188")).resolves.toEqual({
      error: "Endpoint host could not be resolved.",
    });
  });
});
