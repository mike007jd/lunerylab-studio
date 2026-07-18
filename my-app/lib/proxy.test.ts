import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

function mutatingRequest(origin?: string) {
  return new NextRequest("http://127.0.0.1:43123/api/settings", {
    method: "PATCH",
    headers: origin ? { origin } : undefined,
  });
}

describe("desktop API origin boundary", () => {
  it("rejects arbitrary websites even when the desktop runtime is enabled", async () => {
    vi.stubEnv("LUNERY_DESKTOP", "1");
    const response = await proxy(mutatingRequest("https://attacker.example"));
    expect(response.status).toBe(403);
  });

  it("rejects the configured public site from the private desktop API", async () => {
    vi.stubEnv("LUNERY_DESKTOP", "1");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.lunerylab.com");
    const response = await proxy(mutatingRequest("https://www.lunerylab.com"));
    expect(response.status).toBe(403);
  });

  it("accepts the exact Tauri WebView origin and the private server origin", async () => {
    vi.stubEnv("LUNERY_DESKTOP", "1");
    await expect(proxy(mutatingRequest("tauri://localhost"))).resolves.toMatchObject({ status: 200 });
    await expect(proxy(mutatingRequest("http://127.0.0.1:43123"))).resolves.toMatchObject({ status: 200 });
  });

  it("rejects a mutating request with no origin or referer", async () => {
    vi.stubEnv("LUNERY_DESKTOP", "1");
    const response = await proxy(mutatingRequest());
    expect(response.status).toBe(403);
  });
});

describe("web API origin boundary", () => {
  it("does not trust the standalone public site as an API origin", async () => {
    vi.stubEnv("LUNERY_DESKTOP", "0");
    const response = await proxy(mutatingRequest("https://www.lunerylab.com"));
    expect(response.status).toBe(403);
  });
});
