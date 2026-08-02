import fs from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
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

import {
  createPinnedProviderFetch,
  downloadRemoteBytes,
  fetchConfiguredProviderIds,
  fetchDesktopStatusSnapshot,
  pollUntil,
  selectPinnedLookupRecords,
  tryReadByokKey,
  validateProviderEndpoint,
} from "@/lib/server/byok-shared";
import { bumpDesktopStatusRevision } from "@/lib/server/desktop-status-revision";

const temporaryDirs: string[] = [];
const testServers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (dnsMocks.actualLookup) {
    dnsMocks.lookup.mockReset();
    dnsMocks.lookup.mockImplementation(dnsMocks.actualLookup);
  }
  await Promise.all(
    testServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  for (const directory of temporaryDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function listenOnLoopback(server: Server): Promise<number> {
  testServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address.");
  return address.port;
}

describe("validateProviderEndpoint trust boundary", () => {
  it("rejects endpoint URL credentials before resolving the host", async () => {
    await expect(
      validateProviderEndpoint("https://user:password@provider.invalid/v1"),
    ).resolves.toEqual({
      error: "Endpoint must not include URL credentials.",
    });
  });

  it("rejects endpoint base URLs that contain a query or fragment", async () => {
    await expect(
      validateProviderEndpoint("https://api.example.com/v1?redirect="),
    ).resolves.toEqual({
      error: "Endpoint must not include a query or fragment.",
    });
    await expect(
      validateProviderEndpoint("https://api.example.com/v1#/hidden"),
    ).resolves.toEqual({
      error: "Endpoint must not include a query or fragment.",
    });

    // String-joined API paths must stay path segments, never query/fragment text.
    const poisoned = "https://api.example.com/v1?redirect=";
    expect(`${poisoned}/chat/completions`).toBe(
      "https://api.example.com/v1?redirect=/chat/completions",
    );
  });

  it("blocks the complete IPv4-mapped IPv6 private space including hex forms", async () => {
    // Node normalizes dotted-quad mapped forms to hex (`::ffff:7f00:1`).
    await expect(
      validateProviderEndpoint("https://[::ffff:7f00:1]/v1"),
    ).resolves.toMatchObject({
      records: [{ address: "::ffff:7f00:1", family: 6 }],
    });
    await expect(
      validateProviderEndpoint("https://[::ffff:127.0.0.1]/v1"),
    ).resolves.toMatchObject({
      records: [{ address: "::ffff:7f00:1", family: 6 }],
    });
    await expect(
      validateProviderEndpoint("https://[::ffff:0a00:1]/v1"),
    ).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(
      validateProviderEndpoint("https://[::ffff:c0a8:1]/v1"),
    ).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
  });

  it("blocks IPv6 link-local fe80::/10, multicast, and other non-public ranges", async () => {
    await expect(validateProviderEndpoint("https://[fe80::1]/v1")).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(validateProviderEndpoint("https://[feb0::1]/v1")).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(validateProviderEndpoint("https://[ff02::1]/v1")).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(validateProviderEndpoint("https://[fc00::1]/v1")).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(validateProviderEndpoint("https://[fd12::1]/v1")).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(validateProviderEndpoint("https://[2001:db8::1]/v1")).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(validateProviderEndpoint("https://[64:ff9b:1::1]/v1")).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(validateProviderEndpoint("https://[100::1]/v1")).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(validateProviderEndpoint("https://[2002:0808:0808::1]/v1")).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(validateProviderEndpoint("https://[3fff::1]/v1")).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    for (const address of [
      "2001:1::1",
      "2001:1::2",
      "2001:1::3",
      "2001:3::1",
      "2001:4:112::1",
      "2001:20::1",
      "2001:30::1",
    ]) {
      await expect(
        validateProviderEndpoint(`https://[${address}]/v1`),
      ).resolves.toMatchObject({
        records: [{ address, family: 6 }],
      });
    }
    await expect(validateProviderEndpoint("https://[2001:2::1]/v1")).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(validateProviderEndpoint("https://[2001:10::1]/v1")).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(validateProviderEndpoint("https://[2606:4700:4700::1111]/v1")).resolves.toMatchObject({
      records: [{ address: "2606:4700:4700::1111", family: 6 }],
    });
    await expect(validateProviderEndpoint("https://[64:ff9b::808:808]/v1")).resolves.toMatchObject({
      records: [{ address: "64:ff9b::808:808", family: 6 }],
    });
    await expect(validateProviderEndpoint("https://[64:ff9b::7f00:1]/v1")).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(validateProviderEndpoint("https://[::1]/v1")).resolves.toMatchObject({
      records: [{ address: "::1", family: 6 }],
    });
  });

  it("returns every validated address for Node dual-stack auto selection", () => {
    const records = [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ];

    expect(selectPinnedLookupRecords(records, { all: true, family: 0 })).toEqual(records);
    expect(selectPinnedLookupRecords(records, { all: true, family: 4 })).toEqual([
      { address: "1.1.1.1", family: 4 },
    ]);
    expect(selectPinnedLookupRecords(records, { family: 6 })).toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it("blocks DNS answers that resolve to compressed or mapped private addresses", async () => {
    dnsMocks.lookup
      .mockResolvedValueOnce([{ address: "::ffff:7f00:1", family: 6 }])
      .mockResolvedValueOnce([{ address: "::ffff:0a00:1", family: 6 }])
      .mockResolvedValueOnce([{ address: "fe80::abcd", family: 6 }]);

    await expect(
      validateProviderEndpoint("https://loopback-mapped.invalid/v1"),
    ).resolves.toMatchObject({
      records: [{ address: "::ffff:7f00:1", family: 6 }],
    });
    await expect(
      validateProviderEndpoint("https://private-mapped.invalid/v1"),
    ).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });
    await expect(
      validateProviderEndpoint("https://link-local.invalid/v1"),
    ).resolves.toEqual({
      error: "Endpoint points to a private or link-local address.",
    });

    dnsMocks.lookup.mockReset();
  });
});

describe("createPinnedProviderFetch", () => {
  it("connects only to the validated address while preserving the original host", async () => {
    let receivedHost = "";
    let receivedAuth = "";
    let receivedBody = "";
    const port = await listenOnLoopback(
      http.createServer((request, response) => {
        receivedHost = request.headers.host ?? "";
        receivedAuth = request.headers.authorization ?? "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          receivedBody += chunk;
        });
        request.on("end", () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"ok":true}');
        });
      }),
    );
    const providerFetch = createPinnedProviderFetch({
      url: `http://provider.invalid:${port}/v1`,
      records: [{ address: "127.0.0.1", family: 4 }],
    });

    const response = await providerFetch(
      `http://provider.invalid:${port}/v1/models`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: '{"prompt":"hello"}',
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(receivedHost).toBe(`provider.invalid:${port}`);
    expect(receivedAuth).toBe("Bearer secret");
    expect(receivedBody).toBe('{"prompt":"hello"}');
  });

  it("does not follow redirects or allow a request to escape the validated base path", async () => {
    let redirectTargetHit = false;
    const targetPort = await listenOnLoopback(
      http.createServer((_request, response) => {
        redirectTargetHit = true;
        response.end("unexpected");
      }),
    );
    const sourcePort = await listenOnLoopback(
      http.createServer((_request, response) => {
        response.writeHead(302, {
          location: `http://127.0.0.1:${targetPort}/steal`,
        });
        response.end();
      }),
    );
    const providerFetch = createPinnedProviderFetch({
      url: `http://provider.invalid:${sourcePort}/v1`,
      records: [{ address: "127.0.0.1", family: 4 }],
    });

    const response = await providerFetch(
      `http://provider.invalid:${sourcePort}/v1/models`,
      { headers: { Authorization: "Bearer secret" } },
    );
    expect(response.status).toBe(302);
    expect(redirectTargetHit).toBe(false);
    await expect(
      providerFetch(`http://provider.invalid:${sourcePort}/outside`, {
        headers: { Authorization: "Bearer secret" },
      }),
    ).rejects.toMatchObject({
      code: "invalid_provider_endpoint",
    });
  });
});

describe("tryReadByokKey", () => {
  it("reads provider keys from the same environment variables surfaced by desktop status", async () => {
    vi.stubEnv("OPENAI_API_KEY", "  sk-from-env  ");

    await expect(tryReadByokKey("openai")).resolves.toBe("sk-from-env");
  });

  it("supports alternate Gemini environment key names", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "gemini-from-env");

    await expect(tryReadByokKey("gemini")).resolves.toBe("gemini-from-env");
  });

  it("does not treat unknown provider environment variables as configured keys", async () => {
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "");

    await expect(tryReadByokKey("unknown-provider")).resolves.toBeNull();
  });

  it("reports a missing desktop bridge as unavailable for known providers", async () => {
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "");

    await expect(tryReadByokKey("openai")).rejects.toMatchObject({
      code: "keychain_unavailable",
      retryable: true,
    });
  });

  it("reports a missing desktop bridge as unavailable for catalog providers without env mappings", async () => {
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "");

    await expect(tryReadByokKey("openai-compatible")).rejects.toMatchObject({
      code: "keychain_unavailable",
      retryable: true,
    });
  });

  it("raises keychain_rate_limited on a 429 instead of reporting a missing key", async () => {
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Secret-read rate limit exceeded (5/min).", { status: 429 })),
    );

    await expect(tryReadByokKey("openai")).rejects.toMatchObject({
      code: "keychain_rate_limited",
      retryable: true,
    });
  });

  it("still reports a genuinely absent key as null (not rate limited)", async () => {
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );

    await expect(tryReadByokKey("openai")).resolves.toBeNull();
  });

  it("raises keychain_unavailable on a locked or unavailable backend", async () => {
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("System keychain is unavailable", { status: 503 })),
    );

    await expect(tryReadByokKey("openai")).rejects.toMatchObject({
      code: "keychain_unavailable",
      retryable: true,
    });
  });

  it("raises keychain_unavailable on bridge transport failure", async () => {
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connection refused");
    }));

    await expect(tryReadByokKey("openai")).rejects.toMatchObject({
      code: "keychain_unavailable",
      retryable: true,
    });
  });

  it("raises keychain_unavailable on unexpected non-404 bridge responses", async () => {
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bridge error", { status: 500 })));

    await expect(tryReadByokKey("openai")).rejects.toMatchObject({
      code: "keychain_unavailable",
      retryable: true,
    });
  });
});

describe("desktop status cache revision", () => {
  it("bypasses a cached provider snapshot after a cross-bundle mutation marker", async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-status-revision-"));
    temporaryDirs.push(runtimeDir);
    vi.stubEnv("LUNERY_RUNTIME_DIR", runtimeDir);
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          providers: [{ id: "openai", configured: false, keychain_status: "absent" }],
          local_runtimes: [],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          providers: [{ id: "openai", configured: true, keychain_status: "present" }],
          local_runtimes: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await bumpDesktopStatusRevision();
    await expect(fetchConfiguredProviderIds()).resolves.toEqual(new Set());
    await expect(fetchConfiguredProviderIds()).resolves.toEqual(new Set());
    expect(fetchMock).toHaveBeenCalledOnce();

    await bumpDesktopStatusRevision();
    await expect(fetchConfiguredProviderIds()).resolves.toEqual(new Set(["openai"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed status fetch as an empty configured set", async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-status-failure-"));
    temporaryDirs.push(runtimeDir);
    vi.stubEnv("LUNERY_RUNTIME_DIR", runtimeDir);
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("bridge down"))
      .mockResolvedValueOnce(
        Response.json({
          providers: [{ id: "openai", configured: true, keychain_status: "present" }],
          local_runtimes: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await bumpDesktopStatusRevision();
    await expect(fetchConfiguredProviderIds()).resolves.toEqual(new Set());
    await expect(fetchConfiguredProviderIds()).resolves.toEqual(new Set(["openai"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an environment-configured provider available when the keychain is unavailable", async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-status-keychain-"));
    temporaryDirs.push(runtimeDir);
    vi.stubEnv("LUNERY_RUNTIME_DIR", runtimeDir);
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          providers: [{ id: "openai", configured: true, keychain_status: "unknown" }],
          local_runtimes: [],
        }),
      ),
    );

    await bumpDesktopStatusRevision();
    await expect(fetchConfiguredProviderIds()).resolves.toEqual(new Set(["openai"]));
  });

  it("does not negative-cache unknown keychain presence", async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-status-keychain-only-"));
    temporaryDirs.push(runtimeDir);
    vi.stubEnv("LUNERY_RUNTIME_DIR", runtimeDir);
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          providers: [{ id: "openai", configured: false, keychain_status: "unknown" }],
          local_runtimes: [],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          providers: [{ id: "openai", configured: true, keychain_status: "present" }],
          local_runtimes: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await bumpDesktopStatusRevision();
    await expect(fetchConfiguredProviderIds()).resolves.toEqual(new Set());
    await expect(fetchConfiguredProviderIds()).resolves.toEqual(new Set(["openai"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("always refreshes dynamic local runtime state", async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-status-runtime-"));
    temporaryDirs.push(runtimeDir);
    vi.stubEnv("LUNERY_RUNTIME_DIR", runtimeDir);
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:49100");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "test-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          providers: [{ id: "openai", configured: true, keychain_status: "present" }],
          local_runtimes: [{ id: "llama-cpp", endpoint: "embedded", status: "idle" }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          providers: [{ id: "openai", configured: true, keychain_status: "present" }],
          local_runtimes: [
            { id: "llama-cpp", endpoint: "http://127.0.0.1:9001", status: "ready" },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await bumpDesktopStatusRevision();
    await expect(fetchDesktopStatusSnapshot()).resolves.toMatchObject({
      local_runtimes: [{ status: "idle" }],
    });
    await expect(fetchDesktopStatusSnapshot()).resolves.toMatchObject({
      local_runtimes: [{ status: "ready" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("downloadRemoteBytes", () => {
  it("preserves a caller abort instead of wrapping it as a provider error", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      downloadRemoteBytes("https://example.com/model.glb", {
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects provider-result downloads that resolve to mapped private IPv6 hosts", async () => {
    await expect(
      downloadRemoteBytes("https://[::ffff:0a00:1]/model.glb"),
    ).rejects.toMatchObject({
      code: "provider_untrusted_url",
    });
    await expect(
      downloadRemoteBytes("https://[::ffff:7f00:1]/model.glb"),
    ).rejects.toMatchObject({
      code: "provider_untrusted_url",
    });
  });
});

describe("pollUntil", () => {
  it("aborts while waiting between provider status checks", async () => {
    const controller = new AbortController();
    await expect(
      pollUntil({
        fetcher: async () => {
          controller.abort();
          return "pending";
        },
        isDone: () => false,
        deadlineMs: 10_000,
        intervalMs: 1_000,
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
