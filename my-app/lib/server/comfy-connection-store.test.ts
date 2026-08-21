import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("server-only", () => ({}));

let tmpDir: string;
let storeFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comfy-store-"));
  vi.stubEnv("LUNERY_CONFIG_DIR", tmpDir);
  storeFile = path.join(tmpDir, "comfyui-connections.json");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function loadStore() {
  return import("@/lib/server/comfy-connection-store");
}

function loadFrameOrigins() {
  return import("@/lib/server/comfy-frame-origins");
}

function writeFixture(data: unknown) {
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(data), "utf8");
}

describe("comfy-connection-store lifecycle", () => {
  it("creates a connection and makes the first one active", async () => {
    const store = await loadStore();
    const created = await store.saveComfyConnection({
      name: "gmk",
      endpoint: "http://192.168.1.143:8188",
    });
    expect(created.id).toBeTruthy();
    expect(store.getActiveComfyConnection()?.id).toBe(created.id);
  });

  it("updates an existing connection by id and clears stale sync on endpoint change", async () => {
    const store = await loadStore();
    const created = await store.saveComfyConnection({
      name: "gmk",
      endpoint: "http://192.168.1.143:8188",
    });
    await store.setComfySyncSnapshot(created.id, {
      at: new Date().toISOString(),
      system: { comfyUiVersion: "0.33.0" },
      models: { checkpoints: ["a.safetensors"] },
    });
    expect(store.getComfyConnection(created.id)?.lastSync?.system.comfyUiVersion).toBe(
      "0.33.0",
    );

    await store.saveComfyConnection({
      id: created.id,
      name: "gmk-tailscale",
      endpoint: "http://100.120.182.80:8188",
    });
    // The snapshot described the old server — it must not survive the change.
    expect(store.getComfyConnection(created.id)?.lastSync).toBeUndefined();
    expect(store.getComfyConnection(created.id)?.name).toBe("gmk-tailscale");
  });

  it("keeps ssh start config only when both halves are present and well-shaped", async () => {
    const store = await loadStore();
    const created = await store.saveComfyConnection({
      name: "gmk",
      endpoint: "http://192.168.1.143:8188",
      sshStart: { hostAlias: "gmk", command: "~/ai/comfy start" },
    });
    expect(store.getComfyConnection(created.id)?.sshStart).toEqual({
      hostAlias: "gmk",
      command: "~/ai/comfy start",
    });

    // Option-injection aliases are dropped rather than trusted on read.
    const second = await store.saveComfyConnection({
      name: "bad",
      endpoint: "http://127.0.0.1:8188",
      sshStart: { hostAlias: "-oProxyCommand=x", command: "evil" },
    });
    expect(store.getComfyConnection(second.id)?.sshStart).toBeUndefined();
  });

  it("promotes the newest remaining connection after deleting the active one", async () => {
    const store = await loadStore();
    const first = await store.saveComfyConnection({
      name: "a",
      endpoint: "http://127.0.0.1:8188",
    });
    const second = await store.saveComfyConnection({
      name: "b",
      endpoint: "http://192.168.1.5:8188",
    });
    expect(store.getActiveComfyConnection()?.id).toBe(first.id);

    await store.setActiveComfyConnection(second.id);
    await store.deleteComfyConnection(second.id);
    // Active deleted → the remaining connection takes over, not "none".
    expect(store.getActiveComfyConnection()?.id).toBe(first.id);

    await store.deleteComfyConnection(first.id);
    expect(store.getActiveComfyConnection()).toBeUndefined();
    expect(store.listComfyConnections()).toEqual([]);
  });

  it("persists state to disk and reloads it in a fresh module instance", async () => {
    const first = await loadStore();
    const created = await first.saveComfyConnection({
      name: "gmk",
      endpoint: "http://192.168.1.143:8188",
      sshStart: { hostAlias: "gmk", command: "~/ai/comfy start" },
    });
    await first.setComfySyncSnapshot(created.id, {
      at: "2026-08-21T00:00:00.000Z",
      system: { comfyUiVersion: "0.33.0", vramTotalBytes: 48 * 1024 ** 3 },
      models: { diffusion_models: ["minimax_h3.safetensors"] },
    });

    vi.resetModules();
    const reloaded = await loadStore();
    const connection = reloaded.getComfyConnection(created.id);
    expect(connection?.name).toBe("gmk");
    expect(connection?.lastSync?.models.diffusion_models).toEqual(["minimax_h3.safetensors"]);
    expect(reloaded.getActiveComfyConnection()?.id).toBe(created.id);
  });

  it("ignores malformed entries when loading a corrupt-ish fixture", async () => {
    writeFixture({
      connections: [
        { id: "ok", name: "local", endpoint: "http://127.0.0.1:8188" },
        { id: "", name: "no id", endpoint: "http://127.0.0.1:8188" },
        { id: "bad-endpoint", name: "no url", endpoint: "not-a-url" },
        "junk",
      ],
      activeConnectionId: "missing",
    });
    const store = await loadStore();
    expect(store.listComfyConnections().map((c: { id: string }) => c.id)).toEqual(["ok"]);
    // Active id pointing at a dropped entry is discarded, not guessed.
    expect(store.getActiveComfyConnection()).toBeUndefined();
  });

  it("throws and leaves memory untouched when the write fails", async () => {
    const blocker = path.join(tmpDir, "blocker-file");
    fs.writeFileSync(blocker, "not a dir");
    vi.stubEnv("LUNERY_CONFIG_DIR", blocker);
    vi.resetModules();
    const store = await loadStore();

    await expect(
      store.saveComfyConnection({ name: "x", endpoint: "http://127.0.0.1:8188" }),
    ).rejects.toThrow();
    expect(store.listComfyConnections()).toEqual([]);
  });
});

describe("comfy frame origins for CSP", () => {
  it("collects origins from saved connections and skips malformed endpoints", async () => {
    writeFixture({
      connections: [
        { id: "a", name: "lan", endpoint: "http://192.168.1.143:8188" },
        { id: "b", name: "ts", endpoint: "http://100.120.182.80:8188/" },
        { id: "c", name: "broken", endpoint: "::not a url::" },
      ],
    });
    const { listComfyFrameOrigins } = await loadFrameOrigins();
    expect(listComfyFrameOrigins().sort()).toEqual([
      "http://100.120.182.80:8188",
      "http://192.168.1.143:8188",
    ]);
  });

  it("returns no origins when the store is missing", async () => {
    const { listComfyFrameOrigins } = await loadFrameOrigins();
    expect(listComfyFrameOrigins()).toEqual([]);
  });
});
