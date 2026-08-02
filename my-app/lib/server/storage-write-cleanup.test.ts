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
  vi.stubEnv("LUNERY_MEDIA_DIR", tmpDir);
  fs.mkdirSync(path.join(tmpDir, "generated"), { recursive: true });
});

afterEach(() => {
  storage.__storageTestHooks.beforeFinalOpen = null;
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

  it("creates a missing project directory for the first nested restore", async () => {
    const stored = await storage.restoreStoredFile({
      storagePath: "generated/project_first/output.png",
      bytes: Buffer.from("first"),
      mimeType: "image/png",
    });

    expect(fs.readFileSync(stored.absolutePath!, "utf8")).toBe("first");
    expect(fs.statSync(path.join(tmpDir, "generated", "project_first")).isDirectory()).toBe(true);
  });

  it("stages deletion, restores on rollback, and removes only on commit", async () => {
    const original = storage.resolveStoragePath("generated/staged.png");
    fs.writeFileSync(original, "staged");

    const stage = await storage.stageStoredFileDeletion("generated/staged.png");
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.existsSync(storage.resolveStoragePath(stage.stagedStoragePath))).toBe(true);

    await storage.rollbackStoredFileDeletion(stage);
    expect(fs.readFileSync(original, "utf8")).toBe("staged");

    const restaged = await storage.stageStoredFileDeletion("generated/staged.png");
    await storage.commitStoredFileDeletion(restaged);
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.existsSync(storage.resolveStoragePath(restaged.stagedStoragePath))).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "refuses deletion through a symlinked bucket outside the media root",
    async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "storage-outside-"));
      try {
        fs.writeFileSync(path.join(outside, "victim.png"), "keep");
        fs.symlinkSync(outside, path.join(tmpDir, "uploads"), "dir");

        await expect(storage.deleteStoredFile("uploads/victim.png")).rejects.toThrow(
          "Storage path component is a symlink",
        );
        await expect(storage.stageStoredFileDeletion("uploads/victim.png")).rejects.toThrow(
          "Storage path component is a symlink",
        );
        expect(fs.readFileSync(path.join(outside, "victim.png"), "utf8")).toBe("keep");
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a media-root symlink before ensure or listing touches its target",
    async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "storage-root-target-"));
      const missingTarget = path.join(outside, "missing-target");
      const linkedRoot = path.join(tmpDir, "linked-media-root");
      fs.symlinkSync(missingTarget, linkedRoot, "dir");
      vi.stubEnv("LUNERY_MEDIA_DIR", linkedRoot);
      try {
        await expect(storage.ensureStorage()).rejects.toThrow(
          "Storage root must be a real directory",
        );
        await expect(storage.listStoredRelativePaths()).rejects.toThrow(
          "Storage root must be a real directory",
        );
        expect(fs.existsSync(missingTarget)).toBe(false);
        expect(fs.readdirSync(outside)).toEqual([]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects bucket symlinks before ensure or listing touches their targets",
    async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "storage-bucket-target-"));
      const missingTarget = path.join(outside, "missing-target");
      fs.symlinkSync(missingTarget, path.join(tmpDir, "uploads"), "dir");
      try {
        await expect(storage.ensureStorage()).rejects.toThrow(
          "Storage path component is a symlink",
        );
        await expect(storage.listStoredRelativePaths()).rejects.toThrow(
          "Storage path component is a symlink",
        );
        expect(fs.existsSync(missingTarget)).toBe(false);
        expect(fs.readdirSync(outside)).toEqual([]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "deletes a final-component symlink without touching its target",
    async () => {
      const outside = path.join(tmpDir, "outside.png");
      const linked = storage.resolveStoragePath("generated/linked.png");
      fs.writeFileSync(outside, "keep");
      fs.symlinkSync(outside, linked);

      const stage = await storage.stageStoredFileDeletion("generated/linked.png");
      await storage.commitStoredFileDeletion(stage);

      expect(fs.existsSync(linked)).toBe(false);
      expect(fs.readFileSync(outside, "utf8")).toBe("keep");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects read/write/restore/metadata/stream through bucket, project, or final symlinks",
    async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "storage-symlink-escape-"));
      try {
        fs.rmSync(path.join(tmpDir, "generated"), { recursive: true, force: true });
        fs.writeFileSync(path.join(outside, "secret.png"), "secret");
        fs.symlinkSync(outside, path.join(tmpDir, "generated"), "dir");

        await expect(
          storage.restoreStoredFile({
            storagePath: "generated/escape.png",
            bytes: Buffer.from("x"),
            mimeType: "image/png",
          }),
        ).rejects.toThrow("Storage path component is a symlink");
        await expect(storage.readStoredFile("generated/secret.png")).rejects.toThrow(
          "Storage path component is a symlink",
        );
        await expect(storage.getStoredFileMetadata("generated/secret.png")).rejects.toThrow(
          "Storage path component is a symlink",
        );
        await expect(storage.streamStoredFile("generated/secret.png")).rejects.toThrow(
          "Storage path component is a symlink",
        );
        expect(fs.readFileSync(path.join(outside, "secret.png"), "utf8")).toBe("secret");
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
        fs.rmSync(path.join(tmpDir, "generated"), { recursive: true, force: true });
        fs.mkdirSync(path.join(tmpDir, "generated"), { recursive: true });
      }

      const projectOutside = fs.mkdtempSync(path.join(os.tmpdir(), "storage-project-escape-"));
      try {
        fs.writeFileSync(path.join(projectOutside, "nested.png"), "nested");
        fs.symlinkSync(projectOutside, path.join(tmpDir, "generated", "proj_1"), "dir");
        await expect(storage.readStoredFile("generated/proj_1/nested.png")).rejects.toThrow(
          "Storage path component is a symlink",
        );
        await expect(
          storage.restoreStoredFile({
            storagePath: "generated/proj_1/new.png",
            bytes: Buffer.from("x"),
            mimeType: "image/png",
          }),
        ).rejects.toThrow("Storage path component is a symlink");
      } finally {
        fs.rmSync(projectOutside, { recursive: true, force: true });
      }

      const finalOutside = path.join(tmpDir, "final-outside.png");
      const finalLinked = storage.resolveStoragePath("generated/final-link.png");
      fs.writeFileSync(finalOutside, "final");
      fs.symlinkSync(finalOutside, finalLinked);
      await expect(storage.readStoredFile("generated/final-link.png")).rejects.toThrow(
        "Storage path component is a symlink",
      );
      await expect(storage.getStoredFileMetadata("generated/final-link.png")).rejects.toThrow(
        "Storage path component is a symlink",
      );
      await expect(
        storage.restoreStoredFile({
          storagePath: "generated/final-link.png",
          bytes: Buffer.from("overwrite"),
          mimeType: "image/png",
        }),
      ).rejects.toThrow("Storage path component is a symlink");
      expect(fs.readFileSync(finalOutside, "utf8")).toBe("final");
    },
  );

  it.runIf(process.platform !== "win32")(
    "uses O_NOFOLLOW when the final component is exchanged after canonical validation",
    async () => {
      const storedPath = storage.resolveStoragePath("generated/raced-final.png");
      const outside = path.join(tmpDir, "raced-outside.png");
      fs.writeFileSync(storedPath, "inside");
      fs.writeFileSync(outside, "outside");
      let exchanged = false;
      storage.__storageTestHooks.beforeFinalOpen = (absolutePath) => {
        if (exchanged || absolutePath !== storedPath) return;
        exchanged = true;
        fs.unlinkSync(storedPath);
        fs.symlinkSync(outside, storedPath);
      };

      await expect(storage.readStoredFile("generated/raced-final.png")).rejects.toThrow(
        "Storage path component is a symlink",
      );
      expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    },
  );

  it("normalizes a configured root without using a dynamic filesystem trace", () => {
    vi.stubEnv("LUNERY_MEDIA_DIR", `${tmpDir}${path.sep}`);
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
