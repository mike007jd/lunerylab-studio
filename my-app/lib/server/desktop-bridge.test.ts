import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";

let tempRoot: string | null = null;

afterEach(() => {
  vi.unstubAllEnvs();
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
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
