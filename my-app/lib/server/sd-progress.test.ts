import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finishSdProgress } from "@/lib/server/sd-progress";

vi.mock("server-only", () => ({}));

let tempRoot: string | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function makeRuntimeDir() {
  tempRoot = mkdtempSync(path.join(tmpdir(), "lunery-sd-progress-"));
  const runtime = path.join(tempRoot, "runtime");
  mkdirSync(runtime, { recursive: true });
  vi.stubEnv("LUNERY_RUNTIME_DIR", runtime);
  return runtime;
}

describe("finishSdProgress", () => {
  it("posts through the explicit desktop bridge environment", async () => {
    vi.stubEnv("LUNERY_DESKTOP", "1");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:4001");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "env-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await finishSdProgress("run-env", "completed");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4001/sd-progress-finish",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-lunery-desktop-token": "env-token" }),
        body: JSON.stringify({ runId: "run-env", phase: "completed" }),
      }),
    );
  });

  it("posts through the desktop dev bridge registry", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LUNERY_DESKTOP", "1");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "");
    const runtime = makeRuntimeDir();
    writeFileSync(
      path.join(runtime, "desktop-dev-bridge.json"),
      JSON.stringify({ url: "http://127.0.0.1:49152", token: "dev-token" }),
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await finishSdProgress("run-dev", "completed");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/sd-progress-finish",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-lunery-desktop-token": "dev-token" }),
      }),
    );
  });

  it("logs a missing bridge without rejecting the completed job", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LUNERY_DESKTOP", "1");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(finishSdProgress("run-missing", "completed")).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "[lunerylab] SD progress bridge unavailable for /sd-progress-finish (404)",
    );
  });

  it("logs HTTP and transport failures without leaking the bridge token", async () => {
    vi.stubEnv("LUNERY_DESKTOP", "1");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:4001");
    vi.stubEnv("LUNERY_DESKTOP_BRIDGE_TOKEN", "secret-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("failed", { status: 503 }))
      .mockRejectedValueOnce(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(finishSdProgress("run-http", "completed")).resolves.toBeUndefined();
    await expect(finishSdProgress("run-network", "completed")).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenNthCalledWith(
      1,
      "[lunerylab] SD progress bridge /sd-progress-finish failed (503)",
    );
    expect(consoleError).toHaveBeenNthCalledWith(
      2,
      "[lunerylab] SD progress bridge /sd-progress-finish request failed: connection refused",
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret-token");
  });
});
