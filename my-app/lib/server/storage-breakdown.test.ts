import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: { asset: { aggregate: mocks.aggregate } },
}));

import { getStorageBreakdown } from "@/lib/server/storage-breakdown";

const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("getStorageBreakdown", () => {
  it("splits active vs trash from asset rows and sizes models/logs on disk", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunery-profile-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "models"), { recursive: true });
    fs.mkdirSync(path.join(root, "logs"), { recursive: true });
    fs.writeFileSync(path.join(root, "models", "m.gguf"), Buffer.alloc(500));
    fs.writeFileSync(path.join(root, "logs", "desktop-runtime.log"), Buffer.alloc(30));

    vi.stubEnv("LUNERY_HOME", root);

    mocks.aggregate
      .mockResolvedValueOnce({ _sum: { byteSize: 1200 } }) // active
      .mockResolvedValueOnce({ _sum: { byteSize: 340 } }); // trash

    const result = await getStorageBreakdown("user-1");

    expect(result.activeBytes).toBe(1200);
    expect(result.trashBytes).toBe(340);
    expect(result.modelsBytes).toBe(500);
    expect(result.logsBytes).toBe(30);
    // freeDiskBytes is number|null depending on statfs support.
    expect(result.freeDiskBytes === null || typeof result.freeDiskBytes === "number").toBe(true);
  });

  it("treats missing profile dirs as zero rather than throwing", async () => {
    const root = path.join(os.tmpdir(), "lunery-nonexistent-profile-dir-xyz");
    vi.stubEnv("LUNERY_HOME", root);
    mocks.aggregate
      .mockResolvedValueOnce({ _sum: { byteSize: null } })
      .mockResolvedValueOnce({ _sum: { byteSize: null } });

    const result = await getStorageBreakdown("user-1");

    expect(result.activeBytes).toBe(0);
    expect(result.trashBytes).toBe(0);
    expect(result.modelsBytes).toBe(0);
    expect(result.logsBytes).toBe(0);
  });
});
