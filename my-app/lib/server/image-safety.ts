import "server-only";
import sharp, { type Sharp } from "sharp";

// Cap decoded pixel area to block decompression bombs from untrusted bytes
// (provider-returned generations, user uploads). 64 MP ≈ 8000×8000 — far above
// any legitimate generation/export size, well below libvips' ~268 MP default.
export const MAX_INPUT_PIXELS = 64 * 1024 * 1024;

// Hard byte ceiling for an image buffer before we hand it to sharp.
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

let configured = false;

/** Apply process-global libvips limits once. Safe to call repeatedly. */
export function configureSharpRuntime(): void {
  if (configured) return;
  configured = true;
  // Bound the libvips operation cache + worker concurrency so a burst of large
  // images can't pin memory or saturate every core.
  sharp.cache({ memory: 128, files: 0, items: 64 });
  sharp.concurrency(2);
}

/**
 * Construct a sharp pipeline with a pixel-bomb guard and an explicit `failOn`.
 * Use this everywhere we decode bytes that originate from a provider or user
 * instead of calling `sharp()` directly.
 */
export function safeSharp(
  input: Buffer,
  options?: { failOn?: "none" | "truncated" | "error" | "warning" },
): Sharp {
  configureSharpRuntime();
  return sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: options?.failOn ?? "error",
  });
}

/** Throw if a buffer is implausibly large before we even decode it. */
export function assertImageByteSize(bytes: Buffer, label = "image"): void {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`${label} exceeds the maximum allowed size (${MAX_IMAGE_BYTES} bytes).`);
  }
}
