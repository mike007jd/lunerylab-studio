import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import sharp from "sharp";

vi.mock("server-only", () => ({}));

import { prepareImageFiles } from "@/lib/server/file-validation";
import { safeSharp } from "@/lib/server/image-safety";
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

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

async function metadataOkPixelCorruptPng(): Promise<Buffer> {
  const good = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  const shortIdat = deflateSync(Buffer.alloc(20, 0));
  const parts: Buffer[] = [good.subarray(0, 8)];
  let offset = 8;
  while (offset < good.length) {
    const length = good.readUInt32BE(offset);
    const type = good.subarray(offset + 4, offset + 8).toString("ascii");
    const data = good.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") {
      parts.push(pngChunk("IDAT", shortIdat));
    } else if (type === "IEND") {
      parts.push(pngChunk("IEND", Buffer.alloc(0)));
      break;
    } else {
      parts.push(pngChunk(type, data));
    }
    offset += 12 + length;
  }
  return Buffer.concat(parts);
}

async function secondFrameCorruptWebp(): Promise<Buffer> {
  const frame = (background: { r: number; g: number; b: number }) =>
    sharp({
      create: { width: 8, height: 8, channels: 3, background },
    })
      .png()
      .toBuffer();
  const red = await frame({ r: 255, g: 0, b: 0 });
  const green = await frame({ r: 0, g: 255, b: 0 });
  const webp = await sharp([red, green], { join: { animated: true } })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();

  let offset = 12;
  let frameIndex = 0;
  while (offset + 8 <= webp.length) {
    const type = webp.subarray(offset, offset + 4).toString("ascii");
    const size = webp.readUInt32LE(offset + 4);
    if (type === "ANMF" && frameIndex++ === 1) {
      const nestedChunk = offset + 8 + 16;
      const corruptionOffset = nestedChunk + 8 + 14;
      webp[corruptionOffset] = webp[corruptionOffset]! ^ 0xff;
      return webp;
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error("Second animated WebP frame was not found.");
}

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

  const [prepared] = await prepareImageFiles(
    [
      new File(
        [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
        "portrait.jpg",
        { type: "application/octet-stream" },
      ),
    ],
    { maxFiles: 1 },
  );
  const uploaded = await writeReferenceFile(prepared!);

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

    const [prepared] = await prepareImageFiles(
      [
        new File(
          [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
          `wide.${format}`,
          { type: "application/octet-stream" },
        ),
      ],
      { maxFiles: 1 },
    );
    const uploaded = await writeReferenceFile(prepared!);
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
      expect(fs.readFileSync(stored.absolutePath!)).toEqual(bytes);
    }
  });
});

describe("generated image full-frame decode", () => {
  it("rejects metadata-ok pixel-corrupt PNGs before persisting any file", async () => {
    const corrupt = await metadataOkPixelCorruptPng();
    await expect(safeSharp(corrupt).metadata()).resolves.toMatchObject({
      width: 8,
      height: 8,
      format: "png",
    });

    await expect(writeGeneratedImage({ bytes: corrupt })).rejects.toMatchObject({
      status: 502,
      code: "invalid_generated_image",
    });
    expect(fs.readdirSync(tmpDir, { recursive: true })).toEqual([]);
  });

  it("rejects animated WebP corruption outside the first frame before persisting", async () => {
    const corrupt = await secondFrameCorruptWebp();
    await expect(safeSharp(corrupt).metadata()).resolves.toMatchObject({
      format: "webp",
      pages: 2,
    });

    await expect(writeGeneratedImage({ bytes: corrupt })).rejects.toMatchObject({
      status: 502,
      code: "invalid_generated_image",
    });
    expect(fs.readdirSync(tmpDir, { recursive: true })).toEqual([]);
  });

  it("keeps exact original bytes and oriented dimensions for valid generations", async () => {
    const encoded = await sharp({
      create: { width: 32, height: 16, channels: 3, background: "#112233" },
    })
      .jpeg()
      .toBuffer();
    const bytes = await sharp(encoded).withMetadata({ orientation: 6 }).jpeg().toBuffer();

    const generated = await writeGeneratedImage({ bytes, projectId: "project-1" });

    expect(generated).toMatchObject({
      mimeType: "image/jpeg",
      width: 16,
      height: 32,
      byteSize: bytes.byteLength,
    });
    expect(fs.readFileSync(generated.absolutePath!)).toEqual(bytes);
  });
});
