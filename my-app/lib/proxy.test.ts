import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy, trustedDesktopHost } from "@/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

const TRUSTED_PORT = "43123";
const TRUSTED_HOST = `127.0.0.1:${TRUSTED_PORT}`;
const TRUSTED_ORIGIN = `http://${TRUSTED_HOST}`;

function desktopEnv() {
  vi.stubEnv("LUNERY_DESKTOP", "1");
  vi.stubEnv("PORT", TRUSTED_PORT);
}

function request(
  path: string,
  {
    method = "GET",
    origin,
    host,
    headers: extra,
  }: {
    method?: string;
    origin?: string;
    host?: string | null;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = new Headers(extra);
  if (host !== null) {
    headers.set("host", host ?? TRUSTED_HOST);
  }
  if (origin) headers.set("origin", origin);
  return new NextRequest(`http://${TRUSTED_HOST}${path}`, { method, headers });
}

describe("desktop Host boundary", () => {
  it("exposes the startup-trusted Host from PORT", () => {
    desktopEnv();
    expect(trustedDesktopHost()).toBe(TRUSTED_HOST);
  });

  it("rejects missing, malformed, localhost, hostname, wrong-port, forwarded, and arbitrary Host on GET and mutations", async () => {
    desktopEnv();

    const cases: Array<{
      label: string;
      host?: string | null;
      headers?: Record<string, string>;
    }> = [
      { label: "missing", host: null },
      { label: "malformed", host: "127.0.0.1:" },
      { label: "localhost", host: `localhost:${TRUSTED_PORT}` },
      { label: "hostname", host: `evil.example:${TRUSTED_PORT}` },
      { label: "wrong-port", host: "127.0.0.1:9" },
      { label: "arbitrary", host: "evil.example" },
      {
        label: "forwarded-host",
        host: TRUSTED_HOST,
        headers: { "x-forwarded-host": "evil.example" },
      },
      {
        label: "forwarded-proto",
        host: TRUSTED_HOST,
        headers: { "x-forwarded-proto": "https" },
      },
      {
        label: "rfc-forwarded",
        host: TRUSTED_HOST,
        headers: { forwarded: `host=${TRUSTED_HOST};proto=http` },
      },
    ];

    for (const entry of cases) {
      const getResponse = await proxy(
        request("/api/health", {
          method: "GET",
          host: entry.host,
          headers: entry.headers,
        }),
      );
      expect(getResponse.status, `GET ${entry.label}`).toBe(403);

      const patchResponse = await proxy(
        request("/api/settings", {
          method: "PATCH",
          origin: TRUSTED_ORIGIN,
          host: entry.host,
          headers: entry.headers,
        }),
      );
      expect(patchResponse.status, `PATCH ${entry.label}`).toBe(403);
    }
  });

  it("accepts the trusted loopback Host for GET health and mutating APIs", async () => {
    desktopEnv();
    await expect(
      proxy(request("/api/health", { method: "GET" })),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      proxy(
        request("/api/settings", {
          method: "PATCH",
          origin: TRUSTED_ORIGIN,
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("accepts Next-synthesized forwarding headers only at their canonical values", async () => {
    desktopEnv();
    await expect(
      proxy(
        request("/api/health", {
          method: "GET",
          headers: {
            "x-forwarded-host": TRUSTED_HOST,
            "x-forwarded-proto": "http",
          },
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("rejects evil Host on PATCH (403) while trusted Host GET health stays 200", async () => {
    desktopEnv();
    const evilPatch = await proxy(
      request("/api/settings", {
        method: "PATCH",
        origin: TRUSTED_ORIGIN,
        host: "evil.example",
      }),
    );
    expect(evilPatch.status).toBe(403);

    const health = await proxy(request("/api/health", { method: "GET" }));
    expect(health.status).toBe(200);
  });
});

describe("desktop API origin boundary", () => {
  it("rejects arbitrary websites even when the desktop runtime is enabled", async () => {
    desktopEnv();
    const response = await proxy(
      request("/api/settings", {
        method: "PATCH",
        origin: "https://attacker.example",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects the configured public site from the private desktop API", async () => {
    desktopEnv();
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.lunerylab.com");
    const response = await proxy(
      request("/api/settings", {
        method: "PATCH",
        origin: "https://www.lunerylab.com",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("accepts the exact Tauri WebView origin and the private server origin", async () => {
    desktopEnv();
    await expect(
      proxy(
        request("/api/settings", {
          method: "PATCH",
          origin: "tauri://localhost",
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      proxy(
        request("/api/settings", {
          method: "PATCH",
          origin: TRUSTED_ORIGIN,
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("rejects a mutating request with no origin or referer", async () => {
    desktopEnv();
    const response = await proxy(request("/api/settings", { method: "PATCH" }));
    expect(response.status).toBe(403);
  });

  it("rejects localhost Origin even when Host is the trusted loopback", async () => {
    desktopEnv();
    const response = await proxy(
      request("/api/settings", {
        method: "PATCH",
        origin: `http://localhost:${TRUSTED_PORT}`,
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe("web API origin boundary", () => {
  it("does not trust the standalone public site as an API origin", async () => {
    vi.stubEnv("LUNERY_DESKTOP", "0");
    const response = await proxy(
      new NextRequest("http://127.0.0.1:43123/api/settings", {
        method: "PATCH",
        headers: { origin: "https://www.lunerylab.com", host: "127.0.0.1:43123" },
      }),
    );
    expect(response.status).toBe(403);
  });
});
