// Single source for MIME → file-extension mapping. Plain data + a pure
// function, safe to import from both server modules (asset storage) and
// client components (download helpers) — no node/browser-only deps.
export const FILE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "model/gltf-binary": "glb",
  "model/gltf+json": "gltf",
  "model/obj": "obj",
  "model/vnd.fbx": "fbx",
};

export function extensionFromMime(mimeType: string): string {
  return FILE_EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? "png";
}
