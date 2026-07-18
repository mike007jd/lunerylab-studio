/**
 * Platform export — given a source image and one or more platform-size
 * presets, produce ready-to-ship exports (resize + optional crop + encode).
 *
 * Used by:
 *   - the agent tool `export_layer_for_platforms`
 *   - the Canvas export popover (multi-platform batch)
 *
 * Strategy:
 *   - "contain": letterbox the source to fit the preset (preserves entirety)
 *   - "cover":   crop center-of-mass to fill
 */

import "server-only";
import { safeSharp } from "@/lib/server/image-safety";
import {
  findPlatformSize,
  type PlatformSizePreset,
} from "@/lib/constants/platform-sizes";

export type PlatformExportFit = "contain" | "cover";

export interface PlatformExportInput {
  /** Source image bytes (any sharp-supported format). */
  source: Buffer;
  /** Platform preset id. */
  presetId: string;
  /** Default "cover" — crops to fill. */
  fit?: PlatformExportFit;
  /** Optional explicit quality (1-100). Falls back to preset default. */
  quality?: number;
}

export interface PlatformExportResult {
  presetId: string;
  preset: PlatformSizePreset;
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

const DEFAULT_QUALITY = 88;

async function exportForPlatform(input: PlatformExportInput): Promise<PlatformExportResult> {
  const preset = findPlatformSize(input.presetId);
  if (!preset) {
    throw new Error(`Unknown platform size preset: ${input.presetId}`);
  }

  const pipeline = safeSharp(input.source, { failOn: "error" }).resize({
    width: preset.width,
    height: preset.height,
    fit: input.fit ?? "cover",
    position: "attention",
    withoutEnlargement: false,
  });

  let encoded: Buffer;
  const quality = input.quality ?? DEFAULT_QUALITY;
  switch (preset.preferredMime) {
    case "image/jpeg":
      encoded = await pipeline
        .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" })
        .toBuffer();
      break;
    case "image/webp":
      encoded = await pipeline.webp({ quality }).toBuffer();
      break;
    case "image/png":
    default:
      encoded = await pipeline.png({ compressionLevel: 9 }).toBuffer();
      break;
  }

  // If a soft size cap exists and we exceeded it, retry once at lower quality.
  if (preset.maxBytes && encoded.byteLength > preset.maxBytes && preset.preferredMime !== "image/png") {
    const fallbackQuality = Math.max(60, Math.round(quality * 0.7));
    const retryPipeline = safeSharp(input.source, { failOn: "error" }).resize({
      width: preset.width,
      height: preset.height,
      fit: input.fit ?? "cover",
      position: "attention",
    });
    encoded =
      preset.preferredMime === "image/webp"
        ? await retryPipeline.webp({ quality: fallbackQuality }).toBuffer()
        : await retryPipeline
            .jpeg({ quality: fallbackQuality, mozjpeg: true, chromaSubsampling: "4:2:0" })
            .toBuffer();
  }

  return {
    presetId: input.presetId,
    preset,
    bytes: encoded,
    mimeType: preset.preferredMime,
    width: preset.width,
    height: preset.height,
  };
}

export async function exportForPlatforms(
  source: Buffer,
  presetIds: string[],
  options?: { fit?: PlatformExportFit; quality?: number },
): Promise<PlatformExportResult[]> {
  // Run in parallel; sharp releases the libvips threads cooperatively.
  return Promise.all(
    presetIds.map((presetId) =>
      exportForPlatform({
        source,
        presetId,
        fit: options?.fit,
        quality: options?.quality,
      }),
    ),
  );
}
