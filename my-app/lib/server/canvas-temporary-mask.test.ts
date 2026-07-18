import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sniffImageMime: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/byok-shared", () => ({
  sniffImageMime: mocks.sniffImageMime,
}));

import {
  deleteTemporaryCanvasMask,
  isTemporaryCanvasMaskToken,
  readTemporaryCanvasMask,
  storeTemporaryCanvasMask,
} from "./canvas-temporary-mask";

describe("canvas temporary masks", () => {
  let runtimeDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sniffImageMime.mockReturnValue("image/png");
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-mask-test-"));
    vi.stubEnv("LUNERY_RUNTIME_DIR", runtimeDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("stores a PNG under an opaque temporary token without creating an asset", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "mask.png", {
      type: "image/png",
    });
    const token = await storeTemporaryCanvasMask(file);

    expect(isTemporaryCanvasMaskToken(token)).toBe(true);
    expect(fs.readFileSync(path.join(runtimeDir, "canvas-masks", `${token}.png`))).toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it("reads and deletes only valid temporary-mask paths", async () => {
    const token = `cm_${Date.now()}_${"a".repeat(32)}`;
    const directory = path.join(runtimeDir, "canvas-masks");
    fs.mkdirSync(directory, { recursive: true });
    const maskPath = path.join(directory, `${token}.png`);
    fs.writeFileSync(maskPath, Buffer.from([4, 5, 6]));

    await expect(readTemporaryCanvasMask(token)).resolves.toEqual(Buffer.from([4, 5, 6]));
    await deleteTemporaryCanvasMask(token);
    expect(fs.existsSync(maskPath)).toBe(false);
  });

  it("rejects malformed tokens before touching storage", async () => {
    await expect(readTemporaryCanvasMask("../../asset.png")).rejects.toMatchObject({
      code: "invalid_canvas_mask",
    });
    expect(fs.readdirSync(runtimeDir)).toEqual([]);
  });

  it("returns a safe error when a valid token has already been removed", async () => {
    const token = `cm_${Date.now()}_${"b".repeat(32)}`;
    await expect(readTemporaryCanvasMask(token)).rejects.toMatchObject({
      code: "canvas_mask_not_found",
    });
  });
});
