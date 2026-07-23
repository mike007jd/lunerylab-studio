import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { proxyToBridge, requireDesktopBridge } from "@/lib/server/desktop-bridge";

let tempRoot: string | null = null;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("proxyToBridge", () => {
  const bridge = { url: "http://127.0.0.1:49152", token: "dev-token" };

  it("returns a retryable 503 when the bridge cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const response = await proxyToBridge(bridge, "/status");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Desktop runtime bridge is unreachable",
      code: "bridge_unreachable",
      retryable: true,
    });
  });

  it("returns a retryable 504 when the bridge request times out", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));

    const response = await proxyToBridge(bridge, "/status");

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: "Desktop runtime bridge timed out",
      code: "bridge_timeout",
      retryable: true,
    });
  });

  it("preserves status-route custom degradation semantics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const response = await proxyToBridge(
      bridge,
      "/status",
      undefined,
      () => NextResponse.json({ available: false }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ available: false });
  });
});

function makeRuntimeDir() {
  tempRoot = mkdtempSync(path.join(tmpdir(), "lunery-dev-bridge-"));
  const runtime = path.join(tempRoot, "runtime");
  mkdirSync(runtime, { recursive: true });
  vi.stubEnv("LUNERY_RUNTIME_DIR", runtime);
  return runtime;
}

describe("requireDesktopBridge", () => {
  it("uses explicit bridge environment before the dev registry", () => {
    vi.stubEnv("LUNERY_DESKTOP", "1");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:4001");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "env-token");

    expect(requireDesktopBridge()).toEqual({
      url: "http://127.0.0.1:4001",
      token: "env-token",
    });
  });

  it("reads the desktop dev bridge registry when the env bridge is absent", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LUNERY_DESKTOP", "1");
    const runtime = makeRuntimeDir();
    writeFileSync(
      path.join(runtime, "desktop-dev-bridge.json"),
      JSON.stringify({ url: "http://127.0.0.1:49152", token: "dev-token", pid: 123 }),
    );

    expect(requireDesktopBridge()).toEqual({
      url: "http://127.0.0.1:49152",
      token: "dev-token",
    });
  });

  it("does not read the dev bridge registry in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LUNERY_DESKTOP", "1");
    const runtime = makeRuntimeDir();
    writeFileSync(
      path.join(runtime, "desktop-dev-bridge.json"),
      JSON.stringify({ url: "http://127.0.0.1:49152", token: "dev-token", pid: 123 }),
    );

    const response = requireDesktopBridge();
    expect(response).toBeInstanceOf(NextResponse);
    expect((response as NextResponse).status).toBe(404);
  });
});
