import { createHash } from "node:crypto";
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
