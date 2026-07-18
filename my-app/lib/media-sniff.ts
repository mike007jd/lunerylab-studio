// Pure, dependency-free magic-byte sniffers for generated media. Kept out of
// `lib/server/storage.ts` (which is `server-only`) so they can be unit-tested
// directly and reused without dragging in storage/runtime deps.
//
// MIME is always decided by the bytes, never by a provider's content-type
// header — providers can return an HTML/JSON error page or a corrupt blob with
// a `video/*` / `model/*` header, and trusting that would store junk that the
// same-origin asset endpoint then serves back.

/** Identify a video container from its leading bytes, or null if unrecognised. */
export function sniffVideoMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  // ISO BMFF (mp4 / mov / m4v): an 'ftyp' box at offset 4.
  if (bytes.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("latin1");
    return brand.startsWith("qt") ? "video/quicktime" : "video/mp4";
  }
  // WebM / Matroska: EBML header.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }
  return null;
}

/** Identify a 3D model from its leading bytes, or null if unrecognised. */
export function sniff3dModelMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  // GLB: 'glTF' magic, version 2, and a declared total length that must match
  // the actual byte length.
  if (bytes.subarray(0, 4).toString("latin1") === "glTF") {
    const version = bytes.readUInt32LE(4);
    const declaredLength = bytes.readUInt32LE(8);
    return version === 2 && declaredLength === bytes.length ? "model/gltf-binary" : null;
  }
  // FBX binary.
  if (bytes.subarray(0, 18).toString("latin1") === "Kaydara FBX Binary") {
    return "model/vnd.fbx";
  }
  const head = bytes.subarray(0, 512).toString("utf8");
  const trimmed = head.replace(/^﻿/, "").trimStart();
  // glTF JSON: a JSON object declaring an "asset" member.
  if (trimmed.startsWith("{") && /"asset"\s*:/.test(head)) {
    return "model/gltf+json";
  }
  // FBX ASCII.
  if (head.includes("FBXHeaderExtension")) {
    return "model/vnd.fbx";
  }
  // OBJ: ASCII geometry directives.
  if (/^\s*(#|v |vn |vt |f |o |g |mtllib |usemtl )/m.test(head)) {
    return "model/obj";
  }
  return null;
}
