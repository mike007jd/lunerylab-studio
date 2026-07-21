import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("server-only", () => ({}));

import * as storage from "@/lib/server/storage";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-cleanup-"));
  // Local filesystem rooted at the temp dir (absolute path required).
  vi.stubEnv("ECOM_STORAGE_DIR", tmpDir);
  fs.mkdirSync(path.join(tmpDir, "generated"), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeFilesOrCleanup (#7)", () => {
  it("rejects Windows separator traversal before filesystem resolution", () => {
    expect(() => storage.resolveStoragePath("generated/..\\..\\outside.png")).toThrow(
      "Invalid storage path",
    );
    expect(() => storage.resolveStoragePath("uploads/nested\\file.png")).toThrow(
      "Invalid storage path",
    );
  });

  it("defaults local media storage to the Lunery profile instead of the repo", () => {
    vi.unstubAllEnvs();
    const home = path.join(tmpDir, "home");
    vi.stubEnv("HOME", home);

    expect(storage.resolveStoragePath("generated/sample.png")).toBe(
      path.join(home, ".lunerylab", "studio", "data", "media", "generated", "sample.png"),
    );
  });

  it("reports local-only media capability", () => {
    expect(storage.isBlobStorage()).toBe(false);
  });

  it("keeps pure local read/write/delete and not-found behavior", async () => {
    const stored = await storage.restoreStoredFile({
      storagePath: "generated/local-only.png",
      bytes: Buffer.from("png-bytes"),
      mimeType: "image/png",
    });
    expect(stored.absolutePath).toBeTruthy();
    expect(fs.existsSync(stored.absolutePath!)).toBe(true);

    const read = await storage.readStoredFile(stored.storagePath);
    expect(read.file.toString()).toBe("png-bytes");
    expect(read.mimeType).toBe("image/png");

    const meta = await storage.getStoredFileMetadata(stored.storagePath);
    expect(meta).toEqual({ byteSize: "png-bytes".length, mimeType: "image/png" });

    await storage.deleteStoredFile(stored.storagePath);
    expect(fs.existsSync(stored.absolutePath!)).toBe(false);
    await expect(storage.readStoredFile(stored.storagePath)).rejects.toMatchObject({
      status: 404,
      code: "stored_file_not_found",
    });
  });

  it("normalizes a configured root without using a dynamic filesystem trace", () => {
    vi.stubEnv("ECOM_STORAGE_DIR", `${tmpDir}${path.sep}`);
    expect(storage.resolveStoragePath("generated/sample.png")).toBe(
      path.join(tmpDir, "generated", "sample.png"),
    );
  });

  it("deletes already-written files when a later write fails", async () => {
    // Simulate the first write having landed on disk.
    const firstPath = storage.resolveStoragePath("generated/first.png");
    fs.writeFileSync(firstPath, "data");
    expect(fs.existsSync(firstPath)).toBe(true);

    await expect(
      storage.writeFilesOrCleanup([
        () => Promise.resolve({ storagePath: "generated/first.png" }),
        () => Promise.reject(new Error("disk full")),
      ]),
    ).rejects.toThrow("disk full");

    // The orphaned first file must be cleaned up, not left behind.
    expect(fs.existsSync(firstPath)).toBe(false);
  });

  it("returns all results and deletes nothing when every write succeeds", async () => {
    const aPath = storage.resolveStoragePath("generated/a.png");
    const bPath = storage.resolveStoragePath("generated/b.png");
    fs.writeFileSync(aPath, "a");
    fs.writeFileSync(bPath, "b");

    const result = await storage.writeFilesOrCleanup([
      () => Promise.resolve({ storagePath: "generated/a.png", byteSize: 1 }),
      () => Promise.resolve({ storagePath: "generated/b.png", byteSize: 2 }),
    ]);

    expect(result.map((r) => r.storagePath)).toEqual(["generated/a.png", "generated/b.png"]);
    // Both files survive — no cleanup on the happy path.
    expect(fs.existsSync(aPath)).toBe(true);
    expect(fs.existsSync(bPath)).toBe(true);
  });
});
