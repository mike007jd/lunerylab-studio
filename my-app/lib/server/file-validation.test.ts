import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/server/env", () => ({
  getMaxUploadBytesPerFile: () => 10 * 1024 * 1024,
}));

import sharp from "sharp";
import {
  prepareImageFiles,
  type PreparedImage,
} from "@/lib/server/file-validation";
import {
  buildRequestFingerprint,
  preparedImageFingerprint,
} from "@/lib/server/generate-request";

async function pngFile(bytes: Buffer, name = "a.png"): Promise<File> {
  return new File([Uint8Array.from(bytes)], name, { type: "image/png" });
}

async function jpegFile(bytes: Buffer, name = "a.jpg"): Promise<File> {
  return new File([Uint8Array.from(bytes)], name, { type: "image/jpeg" });
}

async function webpFile(bytes: Buffer, name = "a.webp"): Promise<File> {
  return new File([Uint8Array.from(bytes)], name, { type: "image/webp" });
}

async function solidPng(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: color,
    },
  })
    .png()
    .toBuffer();
}

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

/**
 * PNG whose IHDR metadata parses, but the IDAT compressed pixel stream is
 * truncated so full decode (stats) fails.
 */
async function metadataOkPixelCorruptPng(): Promise<Buffer> {
  const good = await solidPng({ r: 10, g: 20, b: 30 });
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
    }).png().toBuffer();
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
      const codec = webp.subarray(nestedChunk, nestedChunk + 4).toString("ascii");
      if (codec !== "VP8 " && codec !== "VP8L") {
        throw new Error(`Unexpected animated WebP codec: ${codec}`);
      }
      const corruptionOffset = nestedChunk + 8 + 14;
      webp[corruptionOffset] = webp[corruptionOffset]! ^ 0xff;
      return webp;
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error("Second animated WebP frame was not found.");
}

describe("prepareImageFiles one-read prepared images", () => {
  it("returns Buffer, trusted MIME, dimensions, and SHA-256 from a single read", async () => {
    const bytes = await solidPng({ r: 10, g: 20, b: 30 });
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    const arrayBufferSpy = vi.spyOn(File.prototype, "arrayBuffer");

    const preparedFiles = await prepareImageFiles([await pngFile(bytes)], { maxFiles: 1 });
    const prepared = preparedFiles[0]!;

    expect(arrayBufferSpy).toHaveBeenCalledTimes(1);
    expect(prepared.mimeType).toBe("image/png");
    expect(prepared.width).toBe(8);
    expect(prepared.height).toBe(8);
    expect(prepared.sha256).toBe(expectedSha);
    expect(prepared.buffer.equals(bytes)).toBe(true);
    arrayBufferSpy.mockRestore();
  });

  it("uses content hash in idempotency fingerprints so same-metadata different-content conflicts", () => {
    const a: PreparedImage = {
      buffer: Buffer.from("a"),
      mimeType: "image/png",
      width: 1,
      height: 1,
      sha256: "hash-a",
      byteSize: 1,
    };
    const b: PreparedImage = {
      ...a,
      buffer: Buffer.from("b"),
      sha256: "hash-b",
    };

    const fpA = buildRequestFingerprint({
      type: "image",
      files: [preparedImageFingerprint(a)],
    });
    const fpB = buildRequestFingerprint({
      type: "image",
      files: [preparedImageFingerprint(b)],
    });
    expect(fpA).not.toBe(fpB);
  });

  it("reports EXIF-oriented dimensions consistently with browser rendering", async () => {
    const raw = await sharp({
      create: {
        width: 12,
        height: 8,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const [prepared] = await prepareImageFiles([await jpegFile(raw)], { maxFiles: 1 });

    expect(prepared).toMatchObject({ width: 8, height: 12 });
    expect(prepared!.buffer.equals(raw)).toBe(true);
  });

  it("rejects images whose metadata parses but compressed pixels are corrupt", async () => {
    const corrupt = await metadataOkPixelCorruptPng();
    await expect(sharp(corrupt).metadata()).resolves.toMatchObject({
      width: 8,
      height: 8,
      format: "png",
    });

    await expect(
      prepareImageFiles([await pngFile(corrupt, "corrupt.png")], { maxFiles: 1 }),
    ).rejects.toMatchObject({
      status: 400,
      code: "unsupported_file_type",
    });
  });

  it("rejects animated images with corruption outside the first frame", async () => {
    const corrupt = await secondFrameCorruptWebp();
    await expect(sharp(corrupt).metadata()).resolves.toMatchObject({
      format: "webp",
      pages: 2,
    });
    await expect(
      sharp(corrupt, { failOn: "warning" }).stats(),
    ).resolves.toBeDefined();
    await expect(
      sharp(corrupt, { animated: true, failOn: "warning" }).stats(),
    ).rejects.toThrow();

    await expect(
      prepareImageFiles([await webpFile(corrupt, "corrupt.webp")], { maxFiles: 1 }),
    ).rejects.toMatchObject({
      status: 400,
      code: "unsupported_file_type",
    });
  });

  it("replays the same fingerprint for identical content", () => {
    const image: PreparedImage = {
      buffer: Buffer.from("same"),
      mimeType: "image/png",
      width: 1,
      height: 1,
      sha256: "same-hash",
      byteSize: 4,
    };
    const fp1 = buildRequestFingerprint({
      type: "video",
      referenceImage: preparedImageFingerprint(image),
    });
    const fp2 = buildRequestFingerprint({
      type: "video",
      referenceImage: preparedImageFingerprint({ ...image }),
    });
    expect(fp1).toBe(fp2);
  });
});
