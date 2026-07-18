import { describe, expect, it } from "vitest";
import { sniff3dModelMime, sniffVideoMime } from "@/lib/media-sniff";

function mp4Bytes(brand = "isom"): Buffer {
  // [4-byte box size][ftyp][major brand]...
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftyp", "latin1"),
    Buffer.from(brand, "latin1"),
    Buffer.alloc(8),
  ]);
}

function glbBytes(version: number, declaredLength: number, total: number): Buffer {
  const buf = Buffer.alloc(Math.max(total, 12));
  buf.write("glTF", 0, "latin1");
  buf.writeUInt32LE(version, 4);
  buf.writeUInt32LE(declaredLength, 8);
  return buf;
}

describe("sniffVideoMime", () => {
  it("accepts a real MP4 (ftyp) container", () => {
    expect(sniffVideoMime(mp4Bytes())).toBe("video/mp4");
    expect(sniffVideoMime(mp4Bytes("qt  "))).toBe("video/quicktime");
  });

  it("accepts WebM (EBML)", () => {
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);
    expect(sniffVideoMime(webm)).toBe("video/webm");
  });

  it("rejects HTML/JSON masquerading as a video", () => {
    expect(sniffVideoMime(Buffer.from("<!doctype html><html>error</html>"))).toBeNull();
    expect(sniffVideoMime(Buffer.from(JSON.stringify({ error: "nope" })))).toBeNull();
    expect(sniffVideoMime(Buffer.alloc(4))).toBeNull();
  });
});

describe("sniff3dModelMime", () => {
  it("accepts a well-formed GLB and rejects bad header/length/version", () => {
    expect(sniff3dModelMime(glbBytes(2, 64, 64))).toBe("model/gltf-binary");
    // wrong declared length
    expect(sniff3dModelMime(glbBytes(2, 999, 64))).toBeNull();
    // wrong version
    expect(sniff3dModelMime(glbBytes(1, 64, 64))).toBeNull();
  });

  it("accepts glTF JSON and OBJ text", () => {
    expect(sniff3dModelMime(Buffer.from('{ "asset": { "version": "2.0" } }'))).toBe(
      "model/gltf+json",
    );
    expect(sniff3dModelMime(Buffer.from("# blender\nv 0 0 0\nv 1 0 0\nf 1 2 3\n"))).toBe(
      "model/obj",
    );
  });

  it("rejects HTML/JSON error pages", () => {
    expect(sniff3dModelMime(Buffer.from("<!doctype html><html></html>"))).toBeNull();
    expect(sniff3dModelMime(Buffer.from(JSON.stringify({ error: "nope" })))).toBeNull();
  });
});
