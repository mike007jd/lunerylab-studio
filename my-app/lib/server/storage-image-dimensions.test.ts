import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";

vi.mock("server-only", () => ({}));

import { writeGeneratedImage, writeReferenceFile } from "@/lib/server/storage";

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-dimensions-"));
  vi.stubEnv("LUNERY_MEDIA_DIR", tmpDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

it("stores the EXIF-corrected dimensions for rotated phone photos", async () => {
  const encoded = await sharp({
    create: {
      width: 1920,
      height: 1080,
      channels: 3,
      background: "#7d4cff",
    },
  })
    .jpeg()
    .toBuffer();
  // Orientation 6 = rotate 90° clockwise on display; browsers render 1080x1920.
  const bytes = await sharp(encoded).withMetadata({ orientation: 6 }).jpeg().toBuffer();

  const uploaded = await writeReferenceFile(
    new File(
      [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
      "portrait.jpg",
      { type: "application/octet-stream" },
    ),
  );

  expect(uploaded).toMatchObject({ mimeType: "image/jpeg", width: 1080, height: 1920 });
});

describe.each([
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
] as const)("%s image storage", (format, expectedMime) => {
  it("returns trusted MIME and the decoded 1920x1080 dimensions for uploads and generations", async () => {
    const bytes = await sharp({
      create: {
        width: 1920,
        height: 1080,
        channels: 3,
        background: "#7d4cff",
      },
    })
      .toFormat(format)
      .toBuffer();

    const uploaded = await writeReferenceFile(
      new File(
        [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
        `wide.${format}`,
        { type: "application/octet-stream" },
      ),
    );
    const generated = await writeGeneratedImage({
      bytes,
      projectId: "project-1",
    });

    for (const stored of [uploaded, generated]) {
      expect(stored).toMatchObject({
        mimeType: expectedMime,
        width: 1920,
        height: 1080,
        byteSize: bytes.byteLength,
      });
      expect(stored.absolutePath).toBeTruthy();
      expect(fs.existsSync(stored.absolutePath!)).toBe(true);
    }
  });
});
